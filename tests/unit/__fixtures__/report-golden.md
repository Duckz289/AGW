# WebCheck Report

## Run Summary

- Run ID: golden-run-id
- Flow: golden-flow
- Status: passed
- Duration: 1000 ms
- Completed steps: 1
- Findings: 1
- Confirmed: 1
- Likely: 0
- Warnings: 0

## Findings

### finding-0001 — Uncaught runtime exception

- Rule: `RT-EXCEPTION`
- Classification: confirmed
- Category: runtime
- Action ID: `action-0001`

Summary:

```
An uncaught exception occurred: Fixture: simulated uncaught exception
```

Observed:

```
Fixture: simulated uncaught exception
```

Expected:

```
no uncaught runtime exception
```

Reproduction:

- Flow: golden-flow

#### Evidence

- seq 3, type `runtime_error`, actionId `action-0001`

## Limitations

- MCP-driven sessions do not produce evidence or a report in this milestone.
- NW-HTTP-ERROR and NW-TRANSPORT-FAILURE only upgrade to confirmed via an inline expectation on the same action; a later separate expect step never upgrades them.
- ST-INFINITE-LOADING and FM-SERVER-ERROR-NOT-SHOWN require explicit flow.checks configuration and produce no findings without it.
- Only five checker rules exist; there is no accessibility, responsive, performance, hydration, session-loss, or duplicate-request rule yet.

## Artifact References

- Events: `events.ndjson`
- Report: `report.json`
