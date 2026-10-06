"""The Docker environment Harbor constructs for an admitted trial.

It re-admits Harbor's final inputs against the sealed contract, arms the trial's credential route,
narrows the container's network, runs agent-phase commands in the sealed environment only, and
finalizes the container boundary after the agent and verifier are done.
"""

import asyncio
import contextlib
import json
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any, Protocol, override, runtime_checkable
from urllib.parse import urlsplit

from harbor.environments.base import ExecResult
from harbor.models.task.config import (
    EnvironmentConfig as TaskEnvironmentConfig,
    NetworkPolicy,
)
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from ..container_boundary import (
    ContainerBoundaryObservation,
    ContainerBoundaryProbe,
    ContainerBoundaryUnproven,
)
from ..vendor_agents import VENDOR_FIXED_ENVIRONMENT
from .admission_contract import (
    ADMISSION_EVIDENCE_FILENAME,
    admit_final_inputs,
    contract_keys,
    evidence_document,
    prepare_admitted_environment,
    validate_persistent_environment,
)
from .network_policy import denylist_addresses
from .sealed_environment import (
    VendorRuntimeProjection,
    agent_search_path,
    trial_scratch_discard_command,
    validate_environment_values,
)
from .trial_admission_io import (
    TRIAL_ROOT,
    HarborTrialAdmissionError,
    PullDisabledDockerEnvironment,
    atomic_write_json,
    environment_digest,
    inspect_image_configuration,
    isolated_command,
    required_text,
)
from .trial_proxy import TrialProxySession

# What a task image may not declare for itself.
#
# Until 2026-08-27 the rule was that an image's own environment had to be a subset of the keys
# this harness injects. That is satisfiable only by an image this harness built. Running the
# unmodified upstream corpus, 47 of 89 tasks were refused -- 46 of them for carrying
# `GPG_KEY`, `PYTHON_VERSION` and `PYTHON_SHA256`, which is what `FROM python:3.x` puts in every
# image built on it.
#
# The subset rule was not what kept the image's environment away from the trial. `isolated_command`
# runs every command as `exec env -i <sealed keys> /bin/bash -c ...`, so the agent and the verifier
# start from an empty environment holding exactly the sealed values, whatever the image declared.
# The one process that does inherit the image's environment is the service's own entrypoint, which
# `docker compose up` starts. These keys are refused because each of them can send that process's
# traffic somewhere else, or load code into it before its main runs. Everything else is admitted
# and recorded: the image is pinned by digest, so what it declares cannot change without the pin
# changing, and the evidence names the full set either way.
IMAGE_ENVIRONMENT_DENYLIST = frozenset({
    "ALL_PROXY", "BASH_ENV", "HTTPS_PROXY", "HTTP_PROXY", "LD_AUDIT", "LD_LIBRARY_PATH",
    "LD_PRELOAD", "NODE_OPTIONS", "NO_PROXY",
})
VERIFIER_UVX_ALIAS = TRIAL_ROOT / "home/.local/bin/uvx"
VERIFIER_UVX_TARGET = PurePosixPath("/opt/terminal-bench-verifier/bin/uvx")


class TrialProxyController(Protocol):
    """The trial's agent, as the admitted environment drives its credential route: armed once the
    final inputs are admitted, revoked on the way down, published after the container stops."""

    @property
    def post_stop_finalization_pending(self) -> bool: ...

    def arm_admitted_proxy(self) -> TrialProxySession: ...

    def revoke_admitted_proxy(self) -> None: ...

    def finalize_after_container_stop(
        self, observation: ContainerBoundaryObservation | None,
    ) -> None: ...


@runtime_checkable
class VendorRuntimeProjector(Protocol):
    """A vendor agent, which also states the environment its CLI needs to reach the route."""

    def project_vendor_runtime(self, session: object) -> VendorRuntimeProjection: ...


def host_load() -> dict[str, object]:
    """The host's run-queue pressure right now, next to the CPU count it is spread over."""
    one, five, fifteen = os.getloadavg()
    return {
        "loadavg_1m": round(one, 2), "loadavg_5m": round(five, 2),
        "loadavg_15m": round(fifteen, 2), "host_cpus": os.cpu_count(),
    }


class AdmittedDockerEnvironment(PullDisabledDockerEnvironment):
    def __init__(
        self, environment_dir: Path, environment_name: str, session_id: str,
        trial_paths: TrialPaths, task_env_config: TaskEnvironmentConfig,
        *args: object, admission: Mapping[str, object], vendor_agent: str | None = None,
        persistent_env: dict[str, str] | None = None,
        mounts: list[ServiceVolumeConfig] | None = None,
        network_policy: NetworkPolicy | None = None,
        phase_network_policies: Sequence[NetworkPolicy] = (),
        extra_docker_compose: Sequence[Path | str] = (), **kwargs: Any,
    ) -> None:
        prepared = prepare_admitted_environment(
            environment_dir, task_env_config, trial_paths, admission, persistent_env,
            mounts, network_policy, phase_network_policies, extra_docker_compose,
        )
        access, denylist, admitted_policy, admitted_phases, contract, canonical_mounts = prepared
        super().__init__(
            environment_dir, environment_name, session_id, trial_paths,
            task_env_config, *args, persistent_env=persistent_env,
            mounts=canonical_mounts, network_policy=admitted_policy,
            phase_network_policies=admitted_phases,
            extra_docker_compose=extra_docker_compose,
            external_network_name=f"{session_id}_default",
            proxy_host=required_text(contract, "proxy_host"),
            container_ipv4=required_text(contract, "container_ipv4"), **kwargs,
        )
        self._network_access = access
        self._denylist = denylist
        self._vendor_agent = vendor_agent
        self._seal_admission(contract, canonical_mounts, trial_paths)

    def _seal_admission(
        self, contract: Mapping[str, object],
        mounts: Sequence[ServiceVolumeConfig], trial_paths: TrialPaths,
    ) -> None:
        self._admission_contract = dict(contract)
        self._admitted_environment_keys = contract_keys(
            contract, "admitted_environment_keys",
        )
        self._admitted_environment_digest = required_text(
            contract, "environment_digest",
        )
        self._admitted_image_ref = required_text(contract, "image_ref")
        self._sealed_mounts = [dict(mount) for mount in mounts]
        self._evidence_path = trial_paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME
        self._proxy_controller: TrialProxyController | None = None
        # False for every phase but the one `AdmittedVerifier` opens. See `verifier_phase`.
        self._verifier_phase = False
        # Filled by `_validate_image_configuration`, which runs before anything is armed. Empty
        # until then, and empty for an image that declares no environment of its own.
        self._image_environment: dict[str, str] = {}

    def bind_proxy_controller(self, controller: TrialProxyController) -> None:
        if self._proxy_controller is not None:
            raise HarborTrialAdmissionError("trial proxy controller is already bound")
        self._proxy_controller = controller

    def _current_admission(
        self,
    ) -> tuple[Mapping[str, object], list[dict[str, object]], dict[str, object]]:
        contract, records, network, mounts = admit_final_inputs(
            self.environment_dir, self.task_env_config, self.trial_paths,
            self._admission_contract, self._persistent_env, self._mounts,
            self.network_policy, self._phase_network_policies,
            self.extra_docker_compose_paths, self._denylist,
        )
        if mounts != self._sealed_mounts:
            raise HarborTrialAdmissionError("Docker mounts differ from the sealed paths")
        return contract, records, network

    def _validate_image_configuration(self) -> None:
        environment, volumes = inspect_image_configuration(self._admitted_image_ref)
        if volumes:
            raise HarborTrialAdmissionError(
                f"image volumes are not admitted: {sorted(volumes)}"
            )
        steering = sorted(
            key for key in environment if key.upper() in IMAGE_ENVIRONMENT_DENYLIST
        )
        if steering:
            raise HarborTrialAdmissionError(
                f"image environment steers the container out of the sealed environment: {steering}"
            )
        self._image_environment = dict(sorted(environment.items()))
        declared = self._persistent_env.get("PATH")
        if declared is not None and declared != agent_search_path(
            self._image_environment.get("PATH", "")
        ):
            # The image is pinned by digest, so this cannot drift without the pin changing --
            # which is exactly why a mismatch means the sealed PATH was built from something
            # other than this image, and the agent would be searching the wrong directories.
            raise HarborTrialAdmissionError(
                "sealed PATH was not derived from the admitted image")

    def _arm_proxy_route(
        self, contract: Mapping[str, object],
    ) -> tuple[dict[str, object], object]:
        if self._proxy_controller is None:
            raise HarborTrialAdmissionError("trial proxy controller is not bound")
        session = self._proxy_controller.arm_admitted_proxy()
        parsed = urlsplit(session.handle.base_url)
        expected_host = required_text(contract, "proxy_host")
        if parsed.scheme != "http" or parsed.hostname != expected_host or parsed.port is None:
            raise HarborTrialAdmissionError("armed proxy differs from admitted network route")
        if session.handle.trial_id != required_text(contract, "trial_id"):
            raise HarborTrialAdmissionError("armed proxy differs from admitted trial identity")
        source = session.handle.manifest_block.get("source_binding")
        if not isinstance(source, Mapping) or source.get("kind") != "ip":
            raise HarborTrialAdmissionError("armed proxy source binding is unsupported")
        # The address the container is configured with and the only address its credential route
        # answers are one decision, so a drift between them refuses the trial rather than
        # producing a route bound to nobody.
        if required_text(source, "value") != required_text(contract, "container_ipv4"):
            raise HarborTrialAdmissionError(
                "armed proxy source binding differs from the admitted container address")
        route = {
            "scheme": parsed.scheme, "host": parsed.hostname, "port": parsed.port,
            "bound_source_ip": required_text(source, "value"),
            "enforcement": self._route_enforcement(expected_host),
            "scope": "current-trial", "trial_id": session.handle.trial_id,
        }
        return route, session

    def _expected_vendor_environment(self, session: object) -> dict[str, str]:
        vendor_agent = self._vendor_agent
        handle = getattr(session, "handle", None)
        base_url = getattr(handle, "base_url", None)
        if not isinstance(base_url, str) or not base_url:
            raise HarborTrialAdmissionError("vendor projection requires an armed proxy URL")
        if vendor_agent == "claude-code":
            token = getattr(handle, "dummy_token", None)
            if not isinstance(token, str) or not token:
                raise HarborTrialAdmissionError("vendor projection requires a dummy token")
            return {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": token}
        if vendor_agent == "codex":
            return dict(VENDOR_FIXED_ENVIRONMENT["codex"])
        if vendor_agent == "pi":
            return dict(VENDOR_FIXED_ENVIRONMENT["pi"])
        raise HarborTrialAdmissionError(f"unsupported vendor agent: {vendor_agent}")

    def _project_vendor_runtime(self, session: object) -> VendorRuntimeProjection:
        controller = self._proxy_controller
        if not isinstance(controller, VendorRuntimeProjector):
            raise HarborTrialAdmissionError("vendor runtime projection is unavailable")
        projection = controller.project_vendor_runtime(session)
        if not isinstance(projection, VendorRuntimeProjection):
            raise HarborTrialAdmissionError("vendor runtime projection is invalid")
        if projection.vendor_agent != self._vendor_agent:
            raise HarborTrialAdmissionError("vendor runtime projection names another vendor")
        actual = dict(projection.environment)
        expected = self._expected_vendor_environment(session)
        unknown = sorted(set(actual) - set(expected))
        if unknown:
            raise HarborTrialAdmissionError(
                f"vendor runtime projection has unknown keys: {unknown}")
        if actual != expected:
            raise HarborTrialAdmissionError("vendor runtime projection has value drift")
        validate_environment_values(actual)
        return VendorRuntimeProjection(projection.vendor_agent, dict(sorted(actual.items())))

    def _reseal_vendor_environment(self, projection: VendorRuntimeProjection) -> None:
        static_environment = dict(self._persistent_env)
        validate_persistent_environment(static_environment, self._admission_contract)
        environment = dict(sorted({**static_environment, **projection.environment}.items()))
        if any(key.startswith("CORTEX_") for key in environment):
            raise HarborTrialAdmissionError("vendor runtime environment contains Cortex keys")
        digest = environment_digest(environment)
        self._persistent_env = environment
        self._admitted_environment_keys = frozenset(environment)
        self._admitted_environment_digest = digest
        self._admission_contract.update(
            admitted_environment_keys=sorted(environment), environment_digest=digest,
        )

    def _route_enforcement(self, proxy_host: str) -> dict[str, str]:
        """What actually constrains this route, rather than what once always did.

        Under `open` nothing does: the container reaches the whole internet and the proxy is
        simply where the credential lives. The port pin only exists for the proxy-only allowlist,
        because it rejects every marked connection that is not to the proxy -- correct when the
        proxy is the sole destination, and fatal to any broader allowlist.
        """
        if not self._network_access.filtered:
            return {"host": "none", "port": "none"}
        effective = self._network_access.effective_policy(proxy_host)
        return {
            "host": "harbor-allowlist" if effective.allowed_hosts else "none",
            "port": (
                "marked-egress-nftables"
                if effective.allowed_hosts == [proxy_host] else "none"
            ),
        }

    def _revoke_proxy(self) -> None:
        if self._proxy_controller is not None:
            self._proxy_controller.revoke_admitted_proxy()

    def _admit_vendor_runtime(
        self, session: object,
    ) -> tuple[VendorRuntimeProjection | None, Mapping[str, object], list[dict[str, object]], dict[str, object]]:
        if self._vendor_agent is None:
            contract, records, network = self._current_admission()
            return None, contract, records, network
        projection = self._project_vendor_runtime(session)
        self._reseal_vendor_environment(projection)
        contract, records, network = self._current_admission()
        return projection, contract, records, network

    @override
    async def start(self, force_build: bool) -> None:
        if force_build:
            raise HarborTrialAdmissionError("force_build bypasses the admitted pinned image")
        contract, _, _ = self._current_admission()
        await asyncio.to_thread(self._validate_image_configuration)
        try:
            route, session = self._arm_proxy_route(contract)
            projection, contract, records, network = self._admit_vendor_runtime(session)
            network["proxy_route"] = route
            document = evidence_document(
                contract, records, network, projection, self._image_environment)
            if projection is not None:
                atomic_write_json(self._evidence_path, document)
            await super().start(force_build=False)
            document["cpuset"] = await self._require_pinned_cpus()
            document["host_load"] = {"started": host_load()}
            await self._enforce_admitted_network(
                required_text(contract, "proxy_host"), int(route["port"]))
            atomic_write_json(self._evidence_path, document)
        except BaseException:
            self._evidence_path.unlink(missing_ok=True)
            self._revoke_proxy()
            raise

    async def _require_pinned_cpus(self) -> dict[str, object]:
        """Read the started container's CPU pin back and refuse a trial that lost it.

        A Compose overlay that was ignored looks exactly like one that worked, and the whole point
        of the pin is that a wall-clock threshold means the same thing in every trial. So the
        applied `CpusetCpus` is read from the running container and stated in the evidence rather
        than assumed from the file that asked for it.
        """
        declared = self.declared_cpuset()
        if declared is None:
            return {"declared": None, "applied": None}
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", "inspect", "--format", "{{.HostConfig.CpusetCpus}}",
             await self._main_container_id()],
            check=False, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise HarborTrialAdmissionError("trial container CPU pin is unobservable")
        applied = (result.stdout or "").strip()
        if applied != declared:
            raise HarborTrialAdmissionError(
                f"trial was pinned to CPUs {declared} but the container was granted "
                f"{applied or 'the whole host'}")
        return {"declared": declared, "applied": applied}

    async def _enforce_admitted_network(self, proxy_host: str, proxy_port: int) -> None:
        """Narrow the started container from its deny-all baseline to the declared policy.

        Nothing happens under `open`: no sidecar exists, so there is no namespace to install rules
        in and nothing claiming to filter. Under `filtered` the order is deliberate — the denylist
        table goes in while the container is still denied everything, so there is no instant in
        which egress is open and unfiltered.
        """
        if not self._network_access.filtered:
            return
        await self._install_denylist_filter(*denylist_addresses(self._denylist))
        effective = self._network_access.effective_policy(proxy_host)
        if effective.allowed_hosts == [proxy_host]:
            # Proxy-only is the historical shape, and the only one where pinning every
            # gost-forwarded connection to the proxy port is correct. With any other allowlist the
            # same rule would reject the very hosts the campaign asked to reach.
            await self._install_proxy_endpoint_filter(proxy_port)
        await self.set_network_policy(effective)

    def _container_boundary_probe(self) -> ContainerBoundaryProbe:
        return ContainerBoundaryProbe()

    async def _main_container_id(self) -> str:
        result = await self._run_docker_compose_command(["ps", "--quiet", "main"])
        values = (result.stdout or "").splitlines()
        if len(values) != 1 or re.fullmatch(r"[a-f0-9]{64}", values[0]) is None:
            raise HarborTrialAdmissionError("trial container identity is unobservable")
        return values[0]

    async def _remove_verifier_uvx_alias(self) -> None:
        """Remove only the verifier installer's known alias before output collection."""
        alias = str(VERIFIER_UVX_ALIAS)
        target = str(VERIFIER_UVX_TARGET)
        command = (
            f"set -eu; alias={alias}; target={target}; "
            "if [ -L \"$alias\" ] "
            "&& [ \"$(readlink -- \"$alias\")\" = \"$target\" ] "
            "&& [ -f \"$target\" ] && [ ! -L \"$target\" ]; then "
            "unlink -- \"$alias\"; fi"
        )
        result = await self._compose_exec(
            command, service="main", cwd=self.task_env_config.workdir,
            env=None, timeout_sec=None, user=self._resolve_user("root"),
        )
        if result.return_code != 0:
            raise HarborTrialAdmissionError("verifier uvx alias removal failed")

    async def _discard_trial_scratch(self) -> None:
        """Discard the scratch trees as root while the container is still alive."""
        # Absolute paths throughout, so this needs no working directory of its own.
        result = await self._compose_exec(
            trial_scratch_discard_command(), service="main",
            cwd=None, env=None, timeout_sec=None, user=self._resolve_user("root"),
        )
        if result.return_code != 0:
            raise HarborTrialAdmissionError("trial scratch discard failed")

    def _record_verified_host_load(self) -> None:
        """State what the rest of the host was doing when this trial's verifier finished.

        The CPU pin fixes how much machine a trial gets, not how loud its neighbours are, and a
        task whose test asserts a wall-clock threshold is sensitive to the difference. Recording
        both ends of the trial makes a timing failure answerable after the fact instead of
        arguable. Evidence only -- a trial that never wrote evidence has already failed for a
        reason this would only obscure.
        """
        self._amend_evidence(host_load=self._both_ends_of_host_load())

    def _both_ends_of_host_load(self) -> dict[str, object]:
        document = self._read_evidence()
        load = document.get("host_load")
        return {**(load if isinstance(load, dict) else {}), "verified": host_load()}

    def _read_evidence(self) -> dict[str, object]:
        if not self._evidence_path.is_file():
            return {}
        document = json.loads(self._evidence_path.read_text())
        return document if isinstance(document, dict) else {}

    def _amend_evidence(self, **fields: object) -> None:
        """Add to the launch evidence after it was written, or do nothing if there is none.

        A trial whose start failed unlinked its evidence on the way out; resurrecting a stub of
        it would only obscure why.
        """
        document = self._read_evidence()
        if not document:
            return
        atomic_write_json(self._evidence_path, {**document, **fields})

    async def _finalize_after_container_stop(self) -> None:
        self._record_verified_host_load()
        controller = self._proxy_controller
        if controller is None or not controller.post_stop_finalization_pending:
            return
        await self._remove_verifier_uvx_alias()
        await self._discard_trial_scratch()
        probe = self._container_boundary_probe()
        census = None
        try:
            container_id = await self._main_container_id()
            census = await probe.capture(container_id)
        except (HarborTrialAdmissionError, ContainerBoundaryUnproven):
            pass
        await self._run_docker_compose_command(["stop"])
        observation = None
        if census is not None:
            try:
                observation = await probe.observe_after_stop(census)
            except ContainerBoundaryUnproven:
                pass
        controller.finalize_after_container_stop(observation)

    @override
    async def stop(self, delete: bool) -> None:
        failure: BaseException | None = None
        try:
            await self._finalize_after_container_stop()
        except BaseException as error:
            failure = error
        try:
            await super().stop(delete=delete)
        except BaseException as cleanup_error:
            if failure is not None:
                raise failure from cleanup_error
            raise
        finally:
            self._revoke_proxy()
        if failure is not None:
            raise failure

    @contextlib.contextmanager
    def verifier_phase(self):
        """Run the enclosed commands the way harbor would, in the image's own environment.

        The agent phase is what sealing protects, and the verifier is not the agent: it scores
        the answer, spends no credential, and its result is only meaningful if the container it
        inspects behaves the way the task author's image does. Inside this block `exec` stops
        replacing the environment, so the task's tests see the image's PATH, HOME and locale,
        plus whatever the task's own `[verifier.env]` declares.
        """
        if self._verifier_phase:
            raise HarborTrialAdmissionError("the verifier phase is already open")
        self._verifier_phase = True
        self._amend_evidence(verifier_phase={"sealed": False})
        try:
            yield
        finally:
            self._verifier_phase = False

    @override
    async def exec(
        self, command: str, cwd: str | None = None,
        env: dict[str, str] | None = None, timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        if self._verifier_phase:
            return await self._compose_exec(
                command, service="main", cwd=cwd or self.task_env_config.workdir,
                env=dict(env) if env else None,
                timeout_sec=timeout_sec, user=self._resolve_user(user),
            )
        merged = self._merge_env(env) or {}
        keys_match = set(merged) == self._admitted_environment_keys
        values_match = environment_digest(merged) == self._admitted_environment_digest
        if not keys_match or not values_match:
            raise HarborTrialAdmissionError(
                "process environment differs from the sealed values"
            )
        return await self._compose_exec(
            isolated_command(command, merged), service="main",
            cwd=cwd or self.task_env_config.workdir, env=None,
            timeout_sec=timeout_sec, user=self._resolve_user(user),
        )
