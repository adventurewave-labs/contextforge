"""Exercise the stock Python SDK against the chat-proxy fixture."""
import json
import os

from openai import OpenAI


def main():
    request = json.loads(os.environ["TEST_PROXY_REQUEST"])
    with OpenAI(base_url=os.environ["TEST_PROXY_URL"], api_key=os.environ["TEST_PROXY_KEY"],
                max_retries=0, timeout=5) as client:
        result = client.chat.completions.create(**request)
        assert result.choices[0].finish_reason == "tool_calls"
        assert result.choices[0].message.tool_calls[0].function.arguments == '{"total":314.15}'
        assert result.usage.total_tokens == 27

        with client.chat.completions.create(**request, stream=True,
                                            stream_options={"include_usage": True}) as stream:
            events = list(stream)
        assert events[0].choices[0].delta.content == "Café"
        assert events[1].choices[0].delta.tool_calls[0].function.arguments == '{"total":314.15}'
        assert events[-1].usage.total_tokens == 27


if __name__ == "__main__":
    main()
