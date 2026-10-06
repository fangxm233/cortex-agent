"""The host side of one trial's credential route, shared by the Cortex and the vendor agents.

Both agents arm the trial-scoped proxy (at construction, or once the sealed environment admits the
final inputs), revoke it exactly once from whichever point ends the trial first, and publish the
outer envelope after the container stops. What differs between them -- when publication becomes
due, and the launch inputs a Cortex arm adds to the envelope -- stays with each agent.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from harbor.models.trial.paths import EnvironmentPaths

from .container_boundary import (
    CONTAINER_BOUNDARY_ATTESTATION_FILENAME,
    ContainerBoundaryObservation,
)
from .launcher.host_credential_vault import HOST_CREDENTIAL_VAULT
from .launcher.trial_admission_io import HarborTrialAdmissionError, atomic_write_json
from .launcher.trial_proxy import (
    TrialProxySession,
    TrialRevocation,
    arm_trial_proxy,
    capture_trial_inventory,
    parse_trial_proxy_spec,
    require_capability_admission,
    revoke_trial_proxy,
)
from .launcher.trial_seed import TrialSeed
from .scan.models import ArtifactInventory, ScanPolicy

if TYPE_CHECKING:
    from .host_finalization import HostFinalizationResult


def consume_host_credential(handle: str | None, seed: TrialSeed | None) -> str | None:
    """Take the real credential out of the vault, after the arm's capability admits it."""
    if handle is None:
        return None
    if seed is None:
        raise HarborTrialAdmissionError("credential handle requires a trial seed")
    require_capability_admission(seed.arm, paid_run=seed.paid_run)
    return HOST_CREDENTIAL_VAULT.consume(handle)


class TrialLifecycle:
    def __init__(
        self, *, artifact_dir: Path, seed: TrialSeed,
        trial_proxy: Mapping[str, object] | None, host_credential: str | None,
        inventory_sources: Mapping[str, Path] | None = None,
    ) -> None:
        self.artifact_dir = artifact_dir
        self.seed = seed
        self._spec = dict(trial_proxy) if trial_proxy is not None else None
        self._host_credential = host_credential
        self._inventory_sources = dict(inventory_sources or {})
        self._awaiting_admission = True
        self._revoked = False
        self.proxy_session: TrialProxySession | None = None
        self.captured_inventory: ArtifactInventory | None = None
        self.revocation: TrialRevocation | None = None
        self.finalization_pending = False

    @property
    def awaiting_admission(self) -> bool:
        return self._awaiting_admission

    def arm(self) -> TrialProxySession | None:
        """Arm the declared route now, for a trial that is not admitted through a sealed start."""
        if self._spec is not None:
            return self._open(self._spec)
        self._host_credential = None
        self._awaiting_admission = False
        if self.seed.paid_run:
            # A paid trial exchanges a real credential, so it may not run without the host route
            # that keeps that credential out of the container.
            raise ValueError(
                "a paid trial requires trial_proxy: the real credential is exchanged on the "
                "host and never enters the container")
        return None

    def arm_admitted(self) -> TrialProxySession:
        """Arm the deferred route once the environment has admitted Harbor's final inputs."""
        if not self._awaiting_admission or self._spec is None:
            raise HarborTrialAdmissionError("trial proxy is not awaiting admission")
        return self._open(self._spec)

    def _open(self, spec: Mapping[str, object]) -> TrialProxySession:
        try:
            session = arm_trial_proxy(
                arm=self.seed.arm, trial_id=self.seed.trial_id,
                upstream_base_url=str(self.seed.credential["upstream_base_url"]),
                spec=parse_trial_proxy_spec(spec), proxy_dir=self.artifact_dir / "proxy",
                trial_roots=(self.artifact_dir,), host_credential=self._host_credential,
                paid_run=self.seed.paid_run,
            )
        finally:
            self._host_credential = None
        self.proxy_session = session
        self._awaiting_admission = False
        self._spec = None
        return session

    def revoke(self) -> TrialRevocation | None:
        """Revoke from whichever lifecycle point ends the trial first, and only once."""
        if self.proxy_session is None or self._revoked:
            return self.revocation
        self._revoked = True
        self.revocation = revoke_trial_proxy(
            self.proxy_session, capture_inventory=self._capture_inventory,
        )
        return self.revocation

    def _capture_inventory(self) -> ArtifactInventory:
        self.captured_inventory = capture_trial_inventory(
            sources=self._inventory_sources, session=self.proxy_session,
            trial_roots=(self.artifact_dir,),
        )
        return self.captured_inventory

    def record_container_boundary(
        self, observation: ContainerBoundaryObservation | None,
    ) -> bool:
        """Write what the boundary observed, once; False when no publication is due.

        A census that is unavailable, or that counts surviving descendants, is written down rather
        than refusing the trial: it is evidence about this run, and destroying the whole record
        over it would discard everything else the trial produced.
        """
        if not self.finalization_pending:
            return False
        self.finalization_pending = False
        path = self.artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME
        path.unlink(missing_ok=True)
        if observation is not None:
            atomic_write_json(path, observation.document(self.seed.trial_id))
        return True

    def finalize(
        self, *, logs_dir: Path, verifier_dir: Path, scan_policy: ScanPolicy,
        npm_artifact: Path | None = None, bundle_root: str | None = None,
    ) -> "HostFinalizationResult":
        # Imported here: host_finalization reaches trial_admission, which imports the vendor agents.
        from .host_finalization import finalize_host_trial

        return finalize_host_trial(
            logs_dir=logs_dir, verifier_dir=verifier_dir, artifact_dir=self.artifact_dir,
            root_run_id=self.seed.root_run_id, trial_id=self.seed.trial_id, arm=self.seed.arm,
            npm_artifact=npm_artifact, bundle_root=bundle_root, revocation=self.revocation,
            scan_policy=scan_policy, container_logs_dir=EnvironmentPaths().agent_dir,
            task=self.seed.task,
        )
