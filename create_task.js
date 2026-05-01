import application from "application";
import { CreateTaskInput } from "./create-task-input.js";

const createTask = async (state) => {
	const { prTitle, prAuthor, prFilesChanged } = state;

	const input = new CreateTaskInput({
		title: prTitle,
		author: prAuthor,
		filesChanged: prFilesChanged,
	});


	application.clientFactory.getTaskClient().createTask(
		state.controllingOrg,
		input
	);

	return { created: true };
}