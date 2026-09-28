//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/fig/shared.ts
var graphql = async ({ exec, query }) => {
	const { stdout } = await exec({
		command: "fig",
		args: [
			"_",
			"request",
			"--route",
			"/graphql",
			"--method",
			"--body",
			JSON.stringify({ query })
		]
	});
	return JSON.parse(stdout).data;
};
var disableForCommandsGenerator = {
	script: [
		"fig",
		"settings",
		"autocomplete.disableForCommands"
	],
	postProcess: (out) => {
		const existing = out.split("\n").filter((item) => item.length > 0);
		return [{
			name: "Disable new CLI...",
			description: `You must pass a valid JSON array of CLI tools contained within single quotes. e.g. '["npm","cd","ls"]'`,
			icon: "fig://icon?type=box",
			insertValue: JSON.stringify(existing.concat(["{cursor}"]))
		}, {
			name: "Enable all commands",
			icon: "fig://icon?type=box",
			insertValue: "'[]'"
		}].concat(existing.map((disabledCommand) => {
			return {
				name: `Enable ${disabledCommand}`,
				icon: "fig://icon?type=box",
				insertValue: JSON.stringify(existing.filter((cmd) => cmd != disabledCommand))
			};
		}));
	}
};
var themesGenerator = {
	script: [
		"fig",
		"theme",
		"--list"
	],
	postProcess: (output) => {
		return output.split("\n").map((theme) => ({
			name: theme.replace(".json", ""),
			icon: "🎨"
		})).concat([
			{
				name: "system",
				icon: "💻",
				priority: 51
			},
			{
				name: "light",
				icon: "fig://template?color=ffffff&badge=☀️",
				priority: 51
			},
			{
				name: "dark",
				icon: "fig://template?color=000000&badge=🌙",
				priority: 51
			}
		]);
	}
};
var SETTINGS_GENERATOR = {
	"autocomplete.disableForCommands": disableForCommandsGenerator,
	"autocomplete.theme": themesGenerator
};
var subsystemsGenerator = { custom: async () => {
	return [
		"figterm",
		"fig_cli",
		"fig_desktop",
		"daemon"
	].map((name) => ({ name }));
} };
var settingsSpecGenerator = async (_, executeShellCommand) => {
	const { stdout } = await executeShellCommand({
		command: "fig",
		args: [
			"_",
			"request",
			"--method",
			"GET",
			"--route",
			"/settings/all"
		]
	});
	const { settings, actions } = JSON.parse(stdout);
	const actionSuggestions = actions.map((action) => ({
		name: action.identifier.startsWith("autocomplete.") ? action.identifier.slice(13) : action.identifier,
		description: action.description,
		icon: "⚡️"
	}));
	return {
		name: "settings",
		subcommands: settings.map(({ settingName: name, description, type, options, default: defaultValue }) => {
			const suggestions = type === "boolean" ? ["true", "false"] : name.startsWith("autocomplete.keybindings.") ? actionSuggestions : options?.map((option) => ({
				name: option["name"] || option,
				description: option["description"] || ""
			}));
			const generators = SETTINGS_GENERATOR[name];
			return {
				name,
				description,
				icon: "fig://icon?type=commandkey",
				args: {
					name: type,
					default: defaultValue,
					suggestions: generators ? [] : suggestions,
					generators
				}
			};
		})
	};
};
var stateGenerator = {
	script: [
		"fig",
		"internal",
		"local-state",
		"all",
		"--format",
		"json"
	],
	postProcess: (out) => {
		const state = JSON.parse(out);
		return Object.keys(state).map((key) => ({
			name: key,
			description: JSON.stringify(state[key])
		}));
	}
};
var pluginsGenerator = (init) => ({
	cache: { strategy: "stale-while-revalidate" },
	custom: async (_tokens, executeShellCommand) => {
		const { stdout } = await executeShellCommand({
			command: "fig",
			args: init.installed ? [
				"plugins",
				"list",
				"--format",
				"json",
				"--installed"
			] : [
				"plugins",
				"list",
				"--format",
				"json"
			]
		});
		return JSON.parse(stdout).map((plugin) => ({
			name: plugin.name,
			icon: !plugin.icon?.startsWith("https://") ? plugin.icon : "📦",
			description: plugin.description
		}));
	}
});
/**
* Fig team
*/
var tokensGenerators = {
	cache: { strategy: "stale-while-revalidate" },
	custom: async (tokens, executeShellCommand) => {
		const teamOptionIndex = tokens.findIndex((value) => value.startsWith("--team"));
		if (teamOptionIndex === -1) return [];
		let teamName;
		if (tokens[teamOptionIndex].includes("=")) teamName = tokens[teamOptionIndex + 1].split("=")[1];
		else teamName = tokens[teamOptionIndex + 1];
		return JSON.parse((await executeShellCommand({
			command: "fig",
			args: [
				"user",
				"tokens",
				"list",
				"--team",
				teamName,
				"--format",
				"json"
			]
		})).stdout).map((token) => {
			return {
				name: token.name,
				description: `Team: ${token.namespace.username}.${token.description ? " " + token.description : ""}`
			};
		});
	}
};
var teamsGenerators = {
	cache: { strategy: "stale-while-revalidate" },
	script: [
		"fig",
		"team",
		"--list",
		"--format",
		"json"
	],
	postProcess: (out) => {
		return JSON.parse(out).map((team) => ({
			name: team.name,
			priority: 75
		}));
	}
};
var membersGenerators = {
	cache: {
		strategy: "stale-while-revalidate",
		ttl: 6e4
	},
	custom: async (tokens, executeShellCommand) => {
		const teamName = tokens.at(-3);
		return JSON.parse((await executeShellCommand({
			command: "fig",
			args: [
				"team",
				"--format",
				"json",
				teamName,
				"members"
			]
		})).stdout).map((member) => {
			return {
				name: member.email,
				description: `Role: ${member.role}`
			};
		});
	}
};
var invitationsGenerators = {
	cache: {
		strategy: "stale-while-revalidate",
		ttl: 6e4
	},
	custom: async (tokens, executeShellCommand) => {
		const teamName = tokens.at(-3);
		return JSON.parse((await executeShellCommand({
			command: "fig",
			args: [
				"team",
				"--format",
				"json",
				teamName,
				"invitations"
			]
		})).stdout).map((invitation) => {
			return {
				name: invitation.email,
				description: `Role: ${invitation.role}`
			};
		});
	}
};
/**
* Fig Scripts
*/
var scriptsFieldsFragment = `fragment ScriptFields on Script {
  name
  fields {
    icon
    displayName
    description
    templateVersion
    tags
    parameters {
      type
      name
      displayName
      description
      text {
        placeholder
      }
      checkbox {
        trueValueSubstitution
        falseValueSubstitution
      }
      selector {
        generators {
          named {
            name
          }
          shellScript {
            script
          }
          type
        }
        placeholder
        suggestions
      }
      path {
        extensions
        fileType
      }
    }
    runtime
  }
  relevanceScore
  lastInvokedAt
  lastInvokedAtByUser
  isOwnedByCurrentUser
}`;
var scriptOptions = (script) => {
	const options = [{
		name: ["-h", "--help"],
		description: "Show help for the script"
	}];
	for (const param of script.fields.parameters) {
		const option = {
			name: `--${param.name}`,
			description: param?.description ?? param?.type,
			isRequired: true
		};
		switch (param.type) {
			case "Text":
				option.args = { name: param.name };
				break;
			case "Selector":
				let generators = [];
				if (param?.selector?.generators) generators = param?.selector?.generators.filter((generator) => generator.type === "ShellScript").map((generator) => ({
					script: [
						"bash",
						"-c",
						generator?.shellScript?.script
					],
					splitOn: "\n"
				}));
				option.args = {
					name: param.name,
					suggestions: param?.selector?.suggestions,
					generators
				};
				break;
			case "Path":
				option.args = {
					name: param.name,
					template: "filepaths"
				};
				break;
			case "Checkbox":
				options.push({
					...option,
					name: `--no-${param.name}`,
					exclusiveOn: [`--${param.name}`]
				});
				option.exclusiveOn = [`--no-${param.name}`];
		}
		options.push(option);
	}
	return options;
};
var scriptsSpecGenerator = async (_, exec) => {
	const data = await graphql({
		exec,
		query: `query Scripts {
    currentUser {
      namespace {
        username
        scripts {
          ...ScriptFields
        }
      }
      teamMemberships {
        team {
          namespace {
            username
            scripts {
              ...ScriptFields
            }
          }
        }
      }
    }
  }

  ${scriptsFieldsFragment}`
	});
	return {
		name: "run",
		subcommands: [...data.currentUser.namespace.scripts.map((script) => ({
			...script,
			namespace: data.currentUser.namespace.username
		})), ...data.currentUser.teamMemberships.flatMap((team) => team.team.namespace.scripts.map((script) => ({
			...script,
			namespace: team.team.namespace.username
		})))].map((script) => {
			const displayName = `${script.fields.displayName ?? script.name} | @${script.namespace}`;
			const name = [`@${script.namespace}/${script.name}`];
			if (script?.isOwnedByCurrentUser) name.push(script.name);
			const options = scriptOptions(script);
			return {
				displayName,
				icon: script?.fields?.icon ?? "⚡️",
				name,
				insertValue: script?.isOwnedByCurrentUser ? script.name : name[0],
				description: script?.fields?.description,
				options
			};
		}),
		filterStrategy: "fuzzy"
	};
};
/**
* Fig CLI
*/
var commandLineToolSpecGenerator = async (_, exec) => {
	const data = await graphql({
		exec,
		query: `query CommandLineTool {
      currentUser {
        namespace {
          username
          commandlineTools {
            ...CommandlineToolFields
          }
        }
        teamMemberships {
          team {
            namespace {
              username
              commandlineTools {
                ...CommandlineToolFields
              }
            }
          }
        }
      }
    }
    
    fragment CommandlineToolFields on CommandlineTool {
      root {
        ...CLICommandFields
      }
      flattenedCommands {
        ...CLICommandFields
      }
    }
    
    fragment CLICommandFields on ICLICommand {
      uuid
      name
      description
      ... on NestedCommand {
        subcommands {
          uuid
        }
      }
      ... on ScriptCommand {
        script {
          ...ScriptFields
        }
      }
    }
    
    ${scriptsFieldsFragment}`
	});
	return {
		name: "cli",
		subcommands: [...data.currentUser.namespace.commandlineTools.map((commandlineTools) => ({
			...commandlineTools,
			namespace: data.currentUser.namespace.username
		})), ...data.currentUser.teamMemberships.flatMap((team) => team.team.namespace.commandlineTools.map((commandlineTools) => ({
			...commandlineTools,
			namespace: team.team.namespace.username
		})))].map((commandlineTools) => {
			const commands = {};
			for (const command of commandlineTools.flattenedCommands) commands[command.uuid] = command;
			const createTree = (root, depth) => {
				if ("subcommands" in root) {
					const subcommands = [];
					for (const command of root.subcommands) subcommands.push(createTree(commands[command.uuid], depth + 1));
					return {
						name: depth === 0 ? `@${commandlineTools.namespace}/${root.name}` : root.name,
						description: root.description,
						subcommands,
						options: [{
							name: ["-h", "--help"],
							description: "Print help information"
						}]
					};
				} else {
					const script = root.script;
					const options = scriptOptions(script);
					return {
						icon: script?.fields?.icon,
						name: root.name,
						description: root.description,
						options
					};
				}
			};
			return createTree(commandlineTools.root, 0);
		})
	};
};
var sshHostsGenerator = {
	script: [
		"fig",
		"_",
		"request",
		"--method",
		"GET",
		"--route",
		"/access/hosts/all"
	],
	cache: { strategy: "stale-while-revalidate" },
	postProcess: (out) => {
		return JSON.parse(out).map((host) => ({
			insertValue: `@${host.namespace}/${host.nickName}`,
			displayName: `${host.nickName} (@${host.namespace})`,
			name: `@${host.namespace}/${host.nickName}`,
			description: host.description
		}));
	}
};
var sshIdentityGenerator = { custom: async (tokens, executeShellCommand) => {
	const host = tokens.slice(2).find((value) => !value.startsWith("-"));
	if (host === void 0) return [];
	return JSON.parse((await executeShellCommand({
		command: "fig",
		args: [
			"ssh",
			host,
			"--get-identities"
		]
	})).stdout).map((host) => ({ name: host.displayName }));
} };
var userGenerator = {
	script: [
		"fig",
		"user",
		"list-accounts"
	],
	postProcess: (out) => {
		if (out.startsWith("error: ")) return [];
		return out.trim().split("\n").map((name) => ({
			name,
			icon: "👤"
		}));
	}
};
var shared_default = {};
//#endregion
export { SETTINGS_GENERATOR, commandLineToolSpecGenerator, shared_default as default, invitationsGenerators, membersGenerators, pluginsGenerator, scriptsSpecGenerator, settingsSpecGenerator, sshHostsGenerator, sshIdentityGenerator, stateGenerator, subsystemsGenerator, teamsGenerators, themesGenerator, tokensGenerators, userGenerator };
