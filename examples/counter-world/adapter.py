#!/usr/bin/env python3
"""Minimal language-independent WorldPort for the yi-world-cli protocol."""

import hashlib
import json
import sys


PROTOCOL = "yi-world-cli"
VERSION = 1
ADAPTER_ID = "counter-python-v1"
WORLD_ID = "counter-python"
CAPABILITY_ID = "counter.increment"
SCENARIO_IDS = ["steady"]
VALUE_SPEC = {
    "schemaVersion": VERSION,
    "observationDimensions": 1,
    "weights": [1],
    "target": [10],
}
EVIDENCE_PUBLIC_KEY = (
    "MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY="
)


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonical_digest(value):
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def state(value, execution_nonce=None, previous_nonces=None):
    nonces = list(previous_nonces or [])
    if execution_nonce is not None:
        nonces = (nonces + [execution_nonce])[-8:]
    return {
        "schemaVersion": VERSION,
        "stateVersion": f"state:{WORLD_ID}:{value}",
        "revision": value,
        "value": value,
        "usedExecutionNonces": nonces,
    }


def observation(current):
    return {
        "schemaVersion": VERSION,
        "vector": [current["value"]],
        "stateVersion": current["stateVersion"],
        "intervalId": f"{WORLD_ID}:interval:{current['revision']}",
        "evidence": [],
    }


def transition(previous, request):
    next_state = state(
        previous["value"] + 1,
        request["executionNonce"],
        previous.get("usedExecutionNonces", []),
    )
    receipt = {
        "schemaVersion": VERSION,
        "status": "ACCEPTED",
        "token": request["token"],
        "basedOnVersion": request["basedOnVersion"],
        "policyVersion": request["policyVersion"],
        "constraintsDigest": request["constraintsDigest"],
        "executionNonce": request["executionNonce"],
        "effectDigest": canonical_digest(next_state),
        "rejectionReason": None,
        "attributionWindowComplete": True,
        "confounderCount": 0,
    }
    return {
        "nextWorldState": next_state,
        "receipt": receipt,
        "postObservation": observation(next_state),
    }


def dispatch(operation, payload):
    if operation == "hello":
        descriptor = {
            "adapterId": ADAPTER_ID,
            "worldId": WORLD_ID,
            "worldVersion": "counter-python-1",
            "capabilityIds": [CAPABILITY_ID],
            "scenarioIds": SCENARIO_IDS,
            "valueSpec": VALUE_SPEC,
            "evidencePublicKey": EVIDENCE_PUBLIC_KEY,
            "supportsStateDependentActions": True,
        }
        return {**descriptor, "descriptorDigest": canonical_digest(descriptor)}
    if operation == "initialState":
        return {"state": state(0)}
    if operation == "actions":
        token = payload["manifest"]["tokenMap"]["entries"][0]["token"]
        return {
            "actions": [
                {
                    "schemaVersion": VERSION,
                    "token": token,
                    "cost": 1,
                    "allowed": True,
                    "safe": True,
                }
            ]
        }
    if operation == "observe":
        return {"observation": observation(payload["state"])}
    if operation == "externalInputs":
        return {"inputs": []}
    if operation == "transition":
        return transition(payload["state"], payload["request"])
    raise ValueError(f"unsupported operation: {operation}")


def respond(request_id, ok, result):
    envelope = {
        "protocol": PROTOCOL,
        "version": VERSION,
        "id": request_id,
        "ok": ok,
    }
    envelope["result" if ok else "error"] = result
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    request = None
    try:
        request = json.loads(line)
        if (
            request.get("protocol") != PROTOCOL
            or request.get("version") != VERSION
            or not isinstance(request.get("id"), str)
        ):
            respond(request.get("id"), False, "unsupported protocol")
            continue
        respond(request["id"], True, dispatch(request["op"], request.get("payload", {})))
    except Exception as error:  # Protocol errors must remain one JSONL response.
        request_id = request.get("id") if isinstance(request, dict) else None
        respond(request_id, False, str(error))
