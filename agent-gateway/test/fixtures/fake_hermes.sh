#!/usr/bin/env bash
# Fake hermes binary for testing agent-gateway's hermesClient validation.
# Mode is selected via FAKE_HERMES_MODE (set in the test process env, which
# execFile inherits):
#   success            - normal answer, usage file completed
#   fail_sse_stdout    - error text leaked to stdout, usage file failed:true  (real bug)
#   fail_empty_usage   - error text on stdout, NO usage file                  (safety net)
MODE="${FAKE_HERMES_MODE:-success}"
USAGE_FILE=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--usage-file" ]; then USAGE_FILE="$a"; fi
  prev="$a"
done

if [ "$MODE" = "success" ]; then
  echo "The capital of France is Paris."
  cat > "$USAGE_FILE" <<EOF
{
  "estimated_cost_usd": 1.4e-05,
  "input_tokens": 24,
  "output_tokens": 39,
  "total_tokens": 63,
  "api_calls": 1,
  "model": "deepseek-v4-flash",
  "session_id": "test_session_1",
  "completed": true,
  "failed": false
}
EOF
  exit 0
elif [ "$MODE" = "fail_sse_stdout" ]; then
  # Mimics the real bug: stream error text leaked to stdout, exit 0.
  echo 'API call failed after 3 retries: HTTP 502: DeepSeek API returned invalid JSON (HTTP 200): data: {"id":"00f5cc1f","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":['
  cat > "$USAGE_FILE" <<EOF
{
  "completed": false,
  "failed": true,
  "api_calls": 1
}
EOF
  exit 0
elif [ "$MODE" = "fail_empty_usage" ]; then
  # Failure with no usage file at all: the stdout-pattern safety net must catch it.
  echo 'API call failed after 3 retries: HTTP 502: Non-retryable error occurred upstream.'
  exit 0
else
  echo "What is the meaning of life? Forty-two, computed from first principles."
  cat > "$USAGE_FILE" <<EOF
{
  "completed": true,
  "failed": false,
  "model": "deepseek-v4-flash"
}
EOF
  exit 0
fi