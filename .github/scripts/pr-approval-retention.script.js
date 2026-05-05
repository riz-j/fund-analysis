import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import { z } from "zod";
import axios from "axios";

/** @node */
const beforeStart = (state) => {
	return {};
}

/** @node */
const fetchPrData = async (state) => {
	const {
		githubToken,
		githubRepository,
		githubPrNumber,
	} = state;

	const client = axios.create({
		headers: {
			"Authorization": `Bearer ${githubToken}`,
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	const { data: pullRequest } = await client.get(
		`https://api.github.com/repos/${githubRepository}/pulls/${githubPrNumber}`,
	);
	const { data: reviews } = await client.get(
		`https://api.github.com/repos/${githubRepository}/pulls/${githubPrNumber}/reviews`,
	);
	const commitId = pullRequest.head.sha;

	const { data: commitDetails } = await client.get(
		`https://api.github.com/repos/${githubRepository}/commits/${commitId}`,
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
		return "retainApprovals";
	}

	if (state.pullRequestData.numberOfApprovals === 0) {
		return "retainApprovals";
	}

	if (/merge.*branch.*(master|main)/i.test(state.commitData.message.trim())) {
		return "retainApprovals";
	}

	if (state.commitData.linesChanged > 100) {
		return "dropApprovals";
	}

	return "decideOutcome";
}

/** @node */
const decideOutcome = async (state) => {
	const model = new ChatBedrockConverse({
		model: "openai.gpt-oss-safeguard-120b",
		region: "ap-southeast-2",
		temperature: 0,
		additionalModelRequestFields: {
			reasoning_effort: "medium",
		},
	}).withStructuredOutput(z.object({
		decision: z.enum(["drop_approvals", "retain_approvals"]),
		justification: z.string(),
	}), {
		method: "json_schema",
		includeRaw: true,
	});

	const result = await model.invoke([
		{ role: "system", content: `
			You decide whether existing PR approvals should be retained or dropped after a new commit.
			Analyze only the new commit diff.
			Default decision: retain_approvals.

			Drop approvals only when the diff clearly introduces a meaningful new risk that reviewers should re-review.

			Retain approvals when the change appears behavior-preserving or low-risk, including:
			- Docs, comments, formatting, renames
			- Tests added or updated
			- Refactors or internal implementation changes
			- Localized code changes where inputs, outputs, API behavior, and side effects appear unchanged
			- Additive changes that do not affect existing behavior
			- Defensive error handling, logging, or observability improvements
			- Dependency, construction, wiring, or plumbing changes where no concrete behavior change is visible
			- Changes where the concern is speculative or based on hidden behavior not shown in the diff

			Do not drop approvals merely because:
			- Production code changed
			- Code was moved, reorganized, or rewritten
			- A dependency, helper, client, factory, wrapper, or abstraction changed
			- The implementation could theoretically behave differently
			- More review might be nice

			Drop approvals only for clear evidence of:
			- Significant feature logic changes
			- Changes to security, billing, data deletion, or migrations

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
		decision: result.parsed.decision,
		justification: result.parsed.justification,
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
		githubRepository,
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
		`https://api.github.com/repos/${githubRepository}/pulls/${githubPrNumber}/reviews`,
	);

	const reviews = reviewsData
		.filter((review) => review.state === "APPROVED");

	const dismissalMessage = justification
		|| "Approvals automatically dismissed.";
		
	for (const review of reviews) {
		await client.put(
			`https://api.github.com/repos/${githubRepository}/pulls/${githubPrNumber}/reviews/${review.id}/dismissals`,
			{ message: dismissalMessage, event: "DISMISS" },
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
	githubRepository: z.string().min(1),
	githubPrNumber: z.number().int().positive(),

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
	githubRepository: Annotation(),
	githubPrNumber: Annotation(),

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
		retainApprovals: "retainApprovals",
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
	githubRepository: process.env.GITHUB_REPOSITORY,
	githubPrNumber: Number(process.env.GITHUB_PR_NUMBER),
});

console.log(result);