# Prose fixtures 0.1.0

These are constructed fixtures, not repository quotations, operator feedback,
frequency evidence or executed model results. Positive means a useful advisory
suggestion; negative means leave unchanged. Check them manually against
[the prompt](prose-prompt.md), including the meaning-preservation check.

| ID | Label | Input | Expected behavior |
| --- | --- | --- | --- |
| P1 | Positive: possession | The agent holds no write token. | Proposed rewrite: “The agent doesn't have a write token.” Do not claim it cannot write. |
| P2 | Positive: identity | The address is no credential. | Proposed rewrite: “The address isn't a credential.” Do not infer it is public. |
| P3 | Positive: requirement | The check needs no broker. | Proposed rewrite: “The check doesn't need a broker.” Do not imply brokers are unsupported. |
| P4 | Positive: permission | Nothing of this run may be uploaded. | Proposed rewrite: “No part of this run is permitted to be uploaded.” Retain prohibition, not inability. |
| P5 | Positive: clauses | The report, which lists failed checks and which contains no secrets, is public. | Proposed rewrite: “The report lists failed checks and contains no secrets. It is public.” Preserve both claims and their subject. |
| P6 | Positive: inversion | Why is not yet known. | Proposed rewrite: “The cause is not yet known.” Do not supply a cause. |
| P7 | Positive: definite referent | This is the one place the reports are written. | Proposed rewrite: “This is the only place the reports are written.” Preserve exclusivity. |
| N1 | Negative: technical negation | No process holds the lock after shutdown. | Keep: lock ownership and timing are precise. |
| N2 | Negative: quotation | The operator wrote “holds no write token”. | Keep quotation unchanged; explain outside it if needed. |
| N3 | Negative: deliberate emphasis | Only then does apply run. | Keep: emphasizes a precondition. |
| N4 | Negative: deliberate contrast | Of the two stores, this is the one that survives a reboot. | Keep: “the one” identifies a contrast. |
| N5 | Negative: scope | Only the operator may approve. | Keep: “can” would change authorization to capability. |
| N6 | Negative: missing evidence | No run has tested this on RHEL 10 yet. | Keep: not evidence of failure. |

Acceptance is semantic, not exact wording: other clear rewrites are acceptable
if they retain all claims. A suggestion that changes permission to capability,
drops uniqueness, edits a quote or invents an actor fails this fixture check.
