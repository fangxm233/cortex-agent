# input:  harbor's verification phase and the admitted trial environment
# output: the task's own tests, run in the environment its image ships
# pos:    Verifier phase boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Harbor hands the verifier the same environment object the agent ran in, and this harness seals
# that object: a PATH of its own, HOME and TMPDIR inside the trial home. Sealing is a property of
# the phase being measured -- it keeps the credential and the host away from the model and gives
# every arm the same surface -- and it has no business in the phase that scores the answer.
#
# Worn by the verifier it silently changed what tasks assert. `which nginx` and `chroot` resolve
# under `/usr/sbin`, which the sealed PATH did not carry, so nginx-request-logging, path-tracing
# and path-tracing-reverse scored zero for every arm of both the Cortex and the vendor baselines
# while the same images and the same tests pass for the upstream oracle solution.

from typing import override

from harbor.models.verifier.result import VerifierResult
from harbor.verifier.verifier import Verifier

from .trial_admission_io import HarborTrialAdmissionError


class AdmittedVerifier(Verifier):
    """Runs the upstream verifier the way upstream runs it: in the image's own environment."""

    @override
    async def verify(self) -> VerifierResult:
        phase = getattr(self.environment, "verifier_phase", None)
        if not callable(phase):
            raise HarborTrialAdmissionError(
                "the admitted verifier requires an environment that separates its phases")
        with phase():
            return await super().verify()
