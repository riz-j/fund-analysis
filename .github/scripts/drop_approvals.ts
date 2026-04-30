const apiRoot = "https://api.github.com";
const dismissalMessage = "Automatically dismissed: new push contained 3 or more lines of changes.";

type Comparison = {
  files?: Array<{ changes?: number }>;
};

type Review = {
  id: number;
  state?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function githubApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnv("GH_TOKEN")}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${init.method ?? "GET"} ${path}\n${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function main() {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const pullRequest = requiredEnv("PR");
  const before = requiredEnv("BEFORE");
  const after = requiredEnv("AFTER");

  const comparison = await githubApi<Comparison>(`/repos/${repository}/compare/${before}...${after}`);
  const lines = comparison.files?.reduce((total, file) => total + (file.changes ?? 0), 0) ?? 0;
  console.log(`Lines changed in this push: ${lines}`);

  if (lines < 3) {
    return;
  }

  const reviews = await githubApi<Review[]>(`/repos/${repository}/pulls/${pullRequest}/reviews`);
  const approvedReviewIds = reviews.filter((review) => review.state === "APPROVED").map((review) => review.id);

  for (const reviewId of approvedReviewIds) {
    await githubApi(`/repos/${repository}/pulls/${pullRequest}/reviews/${reviewId}/dismissals`, {
      method: "PUT",
      body: JSON.stringify({ message: dismissalMessage }),
    });
  }
}

await main();
