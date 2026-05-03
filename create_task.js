import application from "application";
import { CreateTaskInput } from "./create-task-input.js";
import TaskClient from "@/module/clients/TaskClient";

const createTask = async (state) => {
	if (!application.settings.isProduction()) {
		console.log("--> Creating task with state:", state);
	}

	const { prTitle, prAuthor, prFilesChanged } = state;

	const input = new CreateTaskInput({
		title: prTitle,
		author: prAuthor,
		filesChanged: prFilesChanged,
	});

	const taskClient = new TaskClient();
	const taskId = taskClient.createTask(
		state.controllingOrg,
		input
	);

	return {
		created: true,
		taskId,
	};
}

export default createTask;
