//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/defaults.ts
var domain = {
	name: "domain",
	generators: {
		script: ["defaults", "domains"],
		postProcess: function(out) {
			return out.split(",").map((domain) => {
				return { name: domain.trim() };
			});
		}
	},
	suggestions: [{
		name: "-globalDomain",
		description: "Global domain"
	}, {
		name: "-app",
		insertValue: "-app '{cursor}'",
		description: "Application name"
	}]
};
var key = { name: "key" };
var completionSpec = {
	name: "defaults",
	description: "Command line interface to a user's defaults",
	subcommands: [
		{
			name: "read",
			description: "Shows defaults",
			args: [domain, key]
		},
		{
			name: "write",
			description: "Writes key for domain",
			args: [
				domain,
				key,
				{ name: "value" }
			]
		},
		{
			name: "delete",
			description: "Deletes domain or key in domain",
			args: [domain, key]
		},
		{
			name: "rename",
			description: "Renames old_key to new_key",
			args: [
				domain,
				{ name: "old_key" },
				{ name: "new_key" }
			]
		},
		{
			name: "domains",
			description: "Lists all domains"
		},
		{
			name: "find",
			description: "Lists all entries containing word",
			args: {
				name: "word",
				description: "The word to search for"
			}
		},
		{
			name: "help",
			description: "Show help text"
		},
		{
			name: "read-type",
			description: "Shows the type for the given domain, key",
			args: [domain, key]
		}
	]
};
//#endregion
export { completionSpec as default };
