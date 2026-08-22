# input:  read-only mounted Node/PI runtimes and Harbor environment
# output: zero-install PI agent retaining canonical process containment
# pos:    Full-suite mounted PI adapter
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from harbor.environments.base import BaseEnvironment

from cortex_bench_harness.vendor_agents import PreinstalledPi, VendorPreflightError


class MountedContainedPi(PreinstalledPi):
    """Use pinned mounted runtimes while retaining current PI run semantics."""

    async def setup(self, environment: BaseEnvironment) -> None:
        await self._link_runtimes(environment)
        await self._verify_mounted_runtimes(environment)
        await self._preflight_version(environment)
        self._setup_complete = True

    async def _link_runtimes(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "ln -sf /opt/cortex-bench-node/bin/node /usr/local/bin/node && "
                "ln -sf /opt/cortex-bench-pi-runtime/dist/cli.js /usr/local/bin/pi"
            ),
        )

    async def _verify_mounted_runtimes(self, environment: BaseEnvironment) -> None:
        result = await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$HOME/.nvm" && : > "$HOME/.nvm/nvm.sh" && '
                'test "$(node --version)" = v22.19.0 && '
                'test "$(pi --version)" = 0.82.1'
            ),
        )
        if result.return_code != 0:
            raise VendorPreflightError("mounted PI runtime preflight failed")
