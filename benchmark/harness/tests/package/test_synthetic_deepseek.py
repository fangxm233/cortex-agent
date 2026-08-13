# input:  synthetic DeepSeek server and OpenAI chat-completion requests
# output: deterministic write-tool and final-answer SSE turns
# pos:    Contract test for the ZERO-PAID synthetic model endpoint
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import subprocess
import sys
import time
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

from cortex_bench_harness.synthetic_deepseek import SyntheticDeepSeekUpstream

MODEL = "deepseek-v4-flash"


def request(upstream: SyntheticDeepSeekUpstream, messages: list[dict[str, object]]) -> str:
    endpoint = urlsplit(upstream.base_url)
    connection = HTTPConnection(endpoint.hostname, endpoint.port, timeout=3)
    body = json.dumps({
        "model": MODEL, "messages": messages, "stream": True,
        "stream_options": {"include_usage": True}, "max_completion_tokens": 32768,
    })
    connection.request("POST", "/v1/chat/completions", body=body, headers={
        "authorization": "Bearer synthetic", "content-type": "application/json",
    })
    response = connection.getresponse()
    payload = response.read().decode()
    connection.close()
    assert response.status == 200
    return payload


def documents(payload: str) -> list[dict[str, object]]:
    return [json.loads(line.removeprefix("data: ")) for line in payload.splitlines()
            if line.startswith("data: {")]


def test_first_turn_writes_the_literal_from_the_instruction() -> None:
    with SyntheticDeepSeekUpstream() as upstream:
        stream = documents(request(upstream, [
            {"role": "user", "content": "Write the exact text `one` into `/tmp/answer.txt`."},
        ]))
        assert upstream.request_count == 1

    choice = stream[0]["choices"][0]
    call = choice["delta"]["tool_calls"][0]
    assert choice["finish_reason"] == "tool_calls"
    assert call["function"] == {
        "name": "write", "arguments": '{"path":"/tmp/answer.txt","content":"one"}',
    }
    assert stream[-1]["usage"] == {
        "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2,
    }


def test_first_turn_reads_the_literal_from_pi_content_blocks() -> None:
    with SyntheticDeepSeekUpstream() as upstream:
        stream = documents(request(upstream, [
            {"role": "user", "content": [
                {"type": "text", "text": "Write the exact text `blocks` into `/tmp/answer.txt`."},
            ]},
        ]))

    call = stream[0]["choices"][0]["delta"]["tool_calls"][0]
    assert call["function"]["arguments"] == (
        '{"path":"/tmp/answer.txt","content":"blocks"}'
    )


def test_an_unrecognized_instruction_is_refused_instead_of_writing_unknown() -> None:
    with SyntheticDeepSeekUpstream() as upstream:
        endpoint = urlsplit(upstream.base_url)
        connection = HTTPConnection(endpoint.hostname, endpoint.port, timeout=3)
        body = json.dumps({"model": MODEL, "messages": [
            {"role": "user", "content": [{"type": "image", "url": "ignored"}]},
        ], "stream": True})
        connection.request("POST", "/v1/chat/completions", body=body, headers={
            "authorization": "Bearer synthetic", "content-type": "application/json",
        })
        response = connection.getresponse()
        payload = response.read().decode()
        connection.close()

    assert response.status == 400
    assert "unrecognized ZERO-PAID instruction" in payload


def test_module_cli_publishes_loopback_state_and_final_request_count(
    tmp_path: Path,
) -> None:
    state = tmp_path / "upstream.json"
    process = subprocess.Popen(
        [sys.executable, "-m", "cortex_bench_harness.synthetic_deepseek",
         "--state-file", str(state)],
        cwd=Path(__file__).resolve().parents[2], env=os.environ.copy(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not state.is_file():
            assert process.poll() is None
            time.sleep(0.05)
        assert state.is_file()
        published = json.loads(state.read_text(encoding="utf-8"))
        assert published["pid"] == process.pid
        assert published["base_url"].startswith("http://127.0.0.1:")
        upstream = object.__new__(SyntheticDeepSeekUpstream)
        upstream._server = type("Endpoint", (), {
            "server_address": (
                urlsplit(published["base_url"]).hostname,
                urlsplit(published["base_url"]).port,
            ),
        })()
        request(upstream, [
            {"role": "user", "content": "Write the exact text `cli` into `/tmp/answer.txt`."},
        ])
    finally:
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
    assert process.returncode == 0, f"{stdout}\n{stderr}"
    final = json.loads((tmp_path / "upstream.final.json").read_text(encoding="utf-8"))
    assert final == {"pid": process.pid, "requests": 1}


def test_second_turn_finishes_after_the_tool_result() -> None:
    with SyntheticDeepSeekUpstream() as upstream:
        stream = documents(request(upstream, [
            {"role": "user", "content": "Write the exact text `two` into `/tmp/answer.txt`."},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call-write", "type": "function",
                "function": {"name": "write", "arguments": "{}"},
            }]},
            {"role": "tool", "tool_call_id": "call-write", "content": "ok"},
        ]))
        assert upstream.request_count == 1

    choice = stream[0]["choices"][0]
    assert choice["finish_reason"] == "stop"
    assert choice["delta"]["content"] == "done"
    assert stream[-1]["usage"]["total_tokens"] == 2
