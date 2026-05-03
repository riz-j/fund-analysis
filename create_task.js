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

	try {
		const tc = new TaskClient();
		const taskId = tc.createTask(
			state.controllingOrg,
			input
		);
	
		return {
			created: true,
			taskId,
		};

	} catch (error) {
		return {
			created: false,
			error: error.message,
		};
	}

}

export default createTask;
