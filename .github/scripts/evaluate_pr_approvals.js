import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatOpenRouter } from "@langchain/openrouter";
import axios from "axios";
import { z } from "zod";

/** @node */
const beforeStart = (state) => {
	return {};
}

/** @node */
const fetchPrData = async (state) => {
	const {
		githubToken,
		githubRespository,
		githubPrNumber,
	} = state;

	const client = axios.create({
		headers: {
			"Authorization": `Bearer ${githubToken}`,
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	const { data: commits } = await client.get(
		`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}/commits`,
	);
	const { data: pullRequest } = await client.get(
		`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}`,
	);
	const { data: reviews } = await client.get(
		`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}/reviews`,
	);
	const commitId = commits.at(-1).sha;

	const { data: commitDetails } = await client.get(
		`https://api.github.com/repos/${githubRespository}/commits/${commitId}`,
	);
	const message = commitDetails.commit.message;
	const linesChanged = commitDetails.stats.additions + commitDetails.stats.deletions;
	const diff = commitDetails.files
		.map(file => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? ""}`)
		.join("\n");

	const numberOfApprovals = reviews
		.filter(review => review.state === "APPROVED")
		.length;


	return {
		commitData: {
			commitId,
			linesChanged,
			diff,
			message,
		},
		pullRequestData: {
			numberOfApprovals,
			isDraft: pullRequest.draft,
		},
	};
}

/** @conditional_edge */
const routeWorkflow = (state) => {
	if (state.pullRequestData.isDraft) {
		return "beforeEnd";
	}

	if (state.pullRequestData.numberOfApprovals === 0) {
		return "beforeEnd";
	}

	if (state.commitData.linesChanged > 50) {
		state.justification = "Approvals dismissed because the latest commit changed more than 50 lines.";
		return "dropApprovals";
	}

	return "decideOutcome";
}

/** @node */
const decideOutcome = async (state) => {
	const model = new ChatOpenRouter({
		model: "openai/gpt-5.4-nano",
		apiKey: state.openrouterApiKey,
		temperature: 0.0,
		modelKwargs: {
			reasoning: {
				enabled: true,
				effort: "high",
			}
		}
	})
	.withStructuredOutput(z.object({
		decision: z.enum(["drop_approvals", "retain_approvals"]),
		justification: z.string(),
	}));

	const result = await model.invoke([
		{ role: "system", content: `
			You are an AI review assistant responsible for deciding whether existing approvals on a pull request should be retained or dropped after a new commit is pushed.
			Your task is to analyze the new commit's diff and determine whether the changes are safe enough to keep existing approvals,or whether the changes are significant/risky enough that reviewers should re-approve the PR.

			You must make one of two decisions:
			- retain_approvals
			- drop_approvals

			Decision criteria:

			Retain approvals when the new commit contains only changes that are unlikely to alter the behavior, contract, or risk profile of the feature/API, including:
			- Documentation-only changes
			- Comment-only changes
			- Formatting or whitespace changes
			- Variable, function, or file renames where behavior remains the same
			- Minor or medium-impact code changes that do not change feature behavior
			- Refactoring that preserves existing behavior
			- Internal implementation cleanup with no observable behavior change
			- Adding, updating, or improving tests, including:
				- Unit tests
				- API tests
				- Integration tests
				- Test fixtures
				- Test utilities
			- Changes where code is modified but the behavior of the feature, API, or user-facing functionality remains the same

			Drop approvals when the new commit contains changes that may require renewed human review, including:
			- Code changes that alter feature behavior
			- API contract changes
			- Major user-facing behavior changes
			- Logic changes that affect outputs, side effects, validation, permissions, error handling, persistence, networking, security, performance, or concurrency
			- Changes that remove or disable or modify existing functionality
			- Potentially risky changes, even if the intended behavior appears unchanged
			- Changes touching sensitive areas such as:
				- Authentication or authorization
				- Security-sensitive code
				- Payment, billing, or financial logic
				- Data migration or data deletion logic
				- Dependency or build configuration changes with runtime impact
				- Infrastructure, deployment, or production configuration
				- Public APIs or schemas
				- Error handling or retry behavior
				- Concurrency, locking, caching, or async behavior

			Important guidance:
			- Focus only on the new commit's diff, not the entire PR history.
			- Determine whether the new diff meaningfully changes the risk profile of the already-approved PR.
			- If the changes are clearly behavior-preserving, retain approvals.
			- If the changes may alter behavior or introduce meaningful risk, drop approvals.
			- Do not drop approvals merely because code changed; drop approvals only when the code change changes behavior or introduces meaningful risk.
			- If uncertain, prefer drop_approvals when the uncertainty is due to potential behavioral or safety risk.
			- If uncertain but the change appears limited to tests, comments, docs, naming, or behavior-preserving refactoring, prefer retain_approvals.

			Decide based on the following commit diff:
		` },
		{ role: "user", content: `
			# Commit Message:
			${state.commitData.message}

			# Diff:
			${state.commitData.diff}	
		` },
	]);

	return {
		decision: result.decision,
		justification: result.justification,
	};
}

/** @conditional_edge */
const routeAnalyzeDecision = (state) => {
	if (state.decision === "drop_approvals") {
		return "dropApprovals";
	}

	return "retainApprovals";
}

/** @node */
const dropApprovals = async (state) => {
	const {
		githubToken,
		githubRespository,
		githubPrNumber,
		justification,
	} = state;

	const client = axios.create({
		headers: {
			"Authorization": `Bearer ${githubToken}`,
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	const { data: reviewsData } = await client.get(
		`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}/reviews`,
	);

	const reviews = reviewsData
		.filter((review) => review.state === "APPROVED");
		
	for (const review of reviews) {
		await client.put(
			`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}/reviews/${review.id}/dismissals`,
			{ message: justification }
		);
	}
}

/** @node */
const retainApprovals = (state) => {
	return {};
}

/** @node */
const beforeEnd = (state) => {
	return {};
}

const GraphStateSchema = z.object({
	githubToken: z.string().min(1),
	githubRespository: z.string().min(1),
	githubPrNumber: z.number().int().positive(),
	openrouterApiKey: z.string().min(1),

	decision: z.enum(["drop_approvals", "retain_approvals"]).optional(),
	justification: z.string().optional(),
	commitData: z.object({
		commitId: z.string().min(1),
		linesChanged: z.number().int().nonnegative(),
		diff: z.string().optional(),
		message: z.string().optional(),
	}).optional(),
	pullRequestData: z.object({
		numberOfApprovals: z.number().int().nonnegative(),
		isDraft: z.boolean(),
	}).optional(),
}); 

const GraphState = Annotation.Root({
	githubToken: Annotation(),
	githubRespository: Annotation(),
	githubPrNumber: Annotation(),
	openrouterApiKey: Annotation(),

	decision: Annotation({ default: "drop_approvals" }),
	justification: Annotation({ default: "" }),
	commitData: Annotation(),
	pullRequestData: Annotation(),
});

const graph = new StateGraph(GraphState, {
	input: GraphStateSchema,
})
	.addNode("beforeStart", beforeStart)
	.addNode("fetchPrData", fetchPrData)
	.addNode("decideOutcome", decideOutcome)
	.addNode("dropApprovals", dropApprovals)
	.addNode("retainApprovals", retainApprovals)
	.addNode("beforeEnd", beforeEnd)
	.addEdge(START, "beforeStart")
	.addEdge("beforeStart", "fetchPrData")
	.addConditionalEdges("fetchPrData", routeWorkflow, {
		decideOutcome: "decideOutcome",
		dropApprovals: "dropApprovals",
		beforeEnd: "beforeEnd",
	})
	.addConditionalEdges("decideOutcome", routeAnalyzeDecision, {
		dropApprovals: "dropApprovals",
		retainApprovals: "retainApprovals",
	})
	.addEdge("dropApprovals", "beforeEnd")
	.addEdge("retainApprovals", "beforeEnd")
	.addEdge("beforeEnd", END);

const app = graph.compile();

const result = await app.invoke({
	githubToken: process.env.GITHUB_TOKEN,
	githubRespository: process.env.GITHUB_REPOSITORY,
	githubPrNumber: Number(process.env.GITHUB_PR_NUMBER),
	openrouterApiKey: process.env.OPENROUTER_API_KEY,
});

console.log(result);
