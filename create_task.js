import application from "application";
import { CreateTaskInput } from "./create-task-input.js";

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
		const taskId = application.getClientFactory().getTaskClient().createTask(
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
