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
	const commitId = commits.at(-1).sha;

	const { data: commitDetails } = await client.get(
		`https://api.github.com/repos/${githubRespository}/commits/${commitId}`,
	);
	const linesChanged = commitDetails.stats.additions + commitDetails.stats.deletions;
	const diff = commitDetails.files
		.map(file => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? ""}`)
		.join("\n");

	return {
		commitData: {
			commitId,
			linesChanged,
			diff,
		},
		pullRequestData: {
			isDraft: pullRequest.draft,
		},
	};
}

/** @conditional_edge */
const routeWorkflow = (state) => {
	if (state.pullRequestData.isDraft) {
		return "beforeEnd";
	}

	if (state.commitData.linesChanged > 50) {
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
			Your job is to decide whether a pull request should have its approvals dropped or retained based on the commit data.
			If the commit changes a existing behavior of a feature, you should drop approvals.
			If the commit does not change any existing behavior (such as documentation), you should retain approvals.
			Take heed of the file type. For example, changes to .md files are unlikely to change behavior compared to .cfm files.
			Decide based on the following commit diff:
		` },
		{ role: "user", content: state.commitData.diff },
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
	const dismissalMessage = justification || "Approvals dismissed because the latest commit changed more than 50 lines.";
		
	for (const review of reviews) {
		await client.put(
			`https://api.github.com/repos/${githubRespository}/pulls/${githubPrNumber}/reviews/${review.id}/dismissals`,
			{
				message: dismissalMessage,
			}
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
		diff: z.string().min(1),
	}).optional(),
	pullRequestData: z.object({
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
