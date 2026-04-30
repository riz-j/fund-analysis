import json
import os
import urllib.error
import urllib.request

from litellm import completion


MODEL = "openrouter/google/gemma-4-26b-a4b-it"
OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"


def require_env(name: str) -> str:
	value = os.getenv(name)
	if not value:
		raise RuntimeError(f"Missing required environment variable: {name}")
	return value


def generate_joke(api_key: str) -> str:
	response = completion(
		model=MODEL,
		api_key=api_key,
		api_base=OPENROUTER_API_BASE,
		messages=[
			{
				"role": "system",
				"content": "You write clean, family-friendly jokes for GitHub pull request comments.",
			},
			{
				"role": "user",
				"content": (
					"Tell one short, corny joke suitable for a pull request comment. "
					"Return only the joke text with no intro, no explanation, and no markdown fencing."
				),
			},
		],
		temperature=0.8,
		max_tokens=80,
		extra_headers={
			"HTTP-Referer": "https://github.com",
			"X-Title": "fund-analysis-pr-comment",
		},
	)

	message = response.choices[0].message.content
	if not message:
		raise RuntimeError("Model returned an empty response")

	return message.strip()


def post_comment(token: str, repository: str, pr_number: str, body: str) -> None:
	url = f"https://api.github.com/repos/{repository}/issues/{pr_number}/comments"
	payload = json.dumps({"body": body}).encode("utf-8")
	request = urllib.request.Request(
		url,
		data=payload,
		headers={
			"Accept": "application/vnd.github+json",
			"Authorization": f"Bearer {token}",
			"Content-Type": "application/json",
			"User-Agent": "fund-analysis-pr-comment",
		},
		method="POST",
	)

	try:
		with urllib.request.urlopen(request) as response:
			if response.status >= 300:
				raise RuntimeError(f"GitHub API returned unexpected status {response.status}")
	except urllib.error.HTTPError as exc:
		details = exc.read().decode("utf-8", errors="replace")
		raise RuntimeError(f"Failed to post PR comment: {exc.code} {details}") from exc


def main() -> None:
	github_token = require_env("GITHUB_TOKEN")
	repository = require_env("GITHUB_REPOSITORY")
	pr_number = require_env("PR_NUMBER")
	openrouter_api_key = require_env("OPENROUTER_API_KEY")

	joke = generate_joke(openrouter_api_key)
	post_comment(github_token, repository, pr_number, joke)


if __name__ == "__main__":
	main()