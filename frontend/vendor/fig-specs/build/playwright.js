//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/playwright.ts
var browserSuggestions = [
	{
		name: "chromium",
		displayName: "Chromium"
	},
	{
		name: "chrome",
		displayName: "Chrome"
	},
	{
		name: "chrome-beta",
		displayName: "Chrome Beta"
	},
	{
		name: "msedge",
		displayName: "Microsoft Edge"
	},
	{
		name: "msedge-beta",
		displayName: "Microsoft Edge Beta"
	},
	{
		name: "msedge-dev",
		displayName: "Microsoft Edge Dev"
	},
	{
		name: "firefox",
		displayName: "Firefox"
	},
	{
		name: "webkit",
		displayName: "WebKit"
	}
];
var helpOption = {
	name: ["--help", "-h"],
	description: "Display help for command",
	priority: 1
};
var completionSpec = {
	name: "playwright",
	description: "",
	subcommands: [{
		name: "test",
		description: "Run tests with Playwright Test",
		args: {
			name: "tests",
			description: "Test files to run",
			isOptional: true,
			isVariadic: true,
			template: ["filepaths", "folders"]
		},
		options: [
			{
				name: "-g",
				description: "Run the test with the title",
				args: { name: "title" }
			},
			{
				name: "--headed",
				description: "Run tests in headed browsers"
			},
			helpOption
		]
	}, {
		name: "install",
		description: "Running without arguments will install default browsers",
		args: {
			name: "browsers",
			description: "Browser to install",
			isOptional: true,
			isVariadic: true,
			suggestions: browserSuggestions
		},
		options: [{
			name: "--with-deps",
			description: "Install system dependencies for browsers"
		}, helpOption]
	}],
	options: [{
		name: ["--version", "-V"],
		description: "Output the version number"
	}, helpOption]
};
//#endregion
export { completionSpec as default };
