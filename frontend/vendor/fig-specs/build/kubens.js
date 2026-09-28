//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/kubens.ts
var completionSpec = {
	name: "kubens",
	description: "Switch between Kubernetes-namespaces",
	additionalSuggestions: [{
		name: "-",
		priority: 85,
		description: "Switch to previous namespace within the current context",
		icon: "fig://icon?type=asterisk"
	}],
	parserDirectives: { flagsArePosixNoncompliant: true },
	options: [{
		name: ["--help", "-h"],
		description: "Show help for kubens"
	}, {
		name: ["--current", "-c"],
		description: "Show current namespace"
	}],
	args: {
		name: "namespace",
		generators: [{
			script: [
				"bash",
				"-c",
				"kubens | grep -v $(kubens -c)"
			],
			postProcess: (out) => out.split("\n").map((item) => ({
				name: item,
				priority: 90,
				icon: "fig://icon?type=kubernetes"
			}))
		}, {
			script: ["kubens", "-c"],
			postProcess: (out) => {
				return !out ? [] : [{
					name: out,
					priority: 100,
					icon: "⭐️"
				}];
			}
		}],
		isOptional: true
	}
};
//#endregion
export { completionSpec as default };
