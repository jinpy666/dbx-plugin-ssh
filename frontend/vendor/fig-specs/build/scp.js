//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ssh.ts
var knownHostRegex = /(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9]+/;
var resolveAbsolutePath = (path, basePath, home) => {
	if (path.startsWith("/") || path.startsWith("~/") || path === "~") return path.replace("~", home);
	if (basePath.startsWith("/") || basePath.startsWith("~/") || basePath === "~") return basePath.replace("~", home) + (basePath.replace("~", home).endsWith("/") ? "" : "/") + path;
	return basePath + (basePath.endsWith("/") ? "" : "/") + path;
};
var getConfigLines = async (file, executeShellCommand, home, basePath) => {
	const { stdout } = await executeShellCommand({
		command: "cat",
		args: [resolveAbsolutePath(file, basePath, home)]
	});
	const configLines = stdout.split("\n").map((line) => line.trim());
	const includes = configLines.filter((line) => line.toLowerCase().startsWith("include ")).map((line) => line.split(" ")[1]);
	const includeLines = await Promise.all(includes.map((file) => getConfigLines(file, executeShellCommand, home, basePath)));
	return [...configLines, ...includeLines.flat()];
};
var knownHosts = {
	custom: async (tokens, executeCommand, context) => {
		const { stdout } = await executeCommand({
			command: "cat",
			args: [`${context.environmentVariables["HOME"]}/.ssh/known_hosts`]
		});
		return stdout.split("\n").map((line) => {
			const match = knownHostRegex.exec(line);
			if (match) return String(match);
		}).filter((value, index, self) => value && self.indexOf(value) === index).map((knownHost) => ({
			name: (tokens[1].endsWith("@") ? tokens[1] : "") + knownHost,
			description: "SSH host"
		}));
	},
	trigger: "@"
};
var configHosts = { custom: async (tokens, executeShellCommand, context) => {
	return (await getConfigLines("config", executeShellCommand, context.environmentVariables["HOME"], "~/.ssh")).filter((line) => line.trim().toLowerCase().startsWith("host ") && !line.includes("*")).map((host) => ({
		name: host.split(" ")[1],
		description: "SSH host",
		priority: 90
	}));
} };
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/scp.ts
var completionSpec = {
	name: "scp",
	description: "Copies files or directories between hosts on a network",
	args: [{
		name: "sources",
		description: "File or directory, local or remote ([user@]host:[path])",
		isVariadic: true,
		generators: [
			knownHosts,
			configHosts,
			{ template: [
				"history",
				"filepaths",
				"folders"
			] }
		]
	}, {
		name: "target",
		description: "File or directory, local or remote ([user@]host:[path])",
		generators: [
			knownHosts,
			configHosts,
			{ template: [
				"history",
				"filepaths",
				"folders"
			] }
		]
	}],
	options: [
		{
			name: "-3",
			description: `Copies between two remote hosts are transferred through the local
host.  Without this option the data is copied directly between the
two remote hosts.  Note that this option disables the progress
meter and selects batch mode for the second host, since scp cannot
ask for passwords or passphrases for both hosts`
		},
		{
			name: "-4",
			description: "Forces scp to use IPv4 addresses only"
		},
		{
			name: "-6",
			description: "Forces scp to use IPv6 addresses only"
		},
		{
			name: "-A",
			description: "Allows forwarding of ssh-agent(1) to the remote system. The default is not to forward an authentication agent"
		},
		{
			name: "-B",
			description: "Selects batch mode (prevents asking for passwords or passphrases)"
		},
		{
			name: "-C",
			description: "Compression enable. Passes the -C flag to ssh(1) to enable compression"
		},
		{
			name: "-c",
			description: "Selects the cipher to use for encrypting the data transfer. This option is directly passed to ssh(1)",
			args: {
				name: "cipher",
				description: "The selected cipher specification"
			}
		},
		{
			name: "-F",
			description: "Specifies an alternative per-user configuration file for ssh. This option is directly passed to ssh(1)",
			args: {
				name: "ssh_config",
				description: "The selected ssh config"
			}
		},
		{
			name: "-i",
			description: "Selects the file from which the identity (private key) for public key authentication is read. This option is directly passed to ssh(1)",
			args: {
				name: "identity_file",
				description: "Specified identity file"
			}
		},
		{
			name: "-J",
			description: `Connect to the target host by first making an scp connection to the
jump host described by destination and then establishing a TCP
forwarding to the ultimate destination from there.  Multiple jump
hops may be specified separated by comma characters.  This is a
shortcut to specify a ProxyJump configuration directive.  This
option is directly passed to ssh(1)`,
			args: {
				name: "destination",
				description: "Scp destination"
			}
		},
		{
			name: "-l",
			description: "Limits the used bandwidth, specified in Kbit/s",
			args: {
				name: "limit",
				description: "Limit bandwidth in Kbit/s"
			}
		},
		{
			name: "-o",
			description: `Can be used to pass options to ssh in the format used in
ssh_config(5).  This is useful for specifying options for which
there is no separate scp command-line flag.  For full details of
the options listed below, and their possible values, see
ssh_config(5)`,
			args: {
				name: "option",
				suggestions: [
					{ name: "AddressFamily" },
					{ name: "BatchMode" },
					{ name: "BindAddress" },
					{ name: "ChallengeResponseAuthentication" },
					{ name: "CheckHostIP" },
					{ name: "Cipher" },
					{ name: "Ciphers" },
					{ name: "ClearAllForwardings" },
					{ name: "Compression" },
					{ name: "CompressionLevel" },
					{ name: "ConnectionAttempts" },
					{ name: "ConnectTimeout" },
					{ name: "ControlMaster" },
					{ name: "ControlPath" },
					{ name: "ControlPersist" },
					{ name: "DynamicForward" },
					{ name: "EscapeChar" },
					{ name: "ExitOnForwardFailure" },
					{ name: "ForwardAgent" },
					{ name: "ForwardX11" },
					{ name: "ForwardX11Timeout" },
					{ name: "ForwardX11Trusted" },
					{ name: "GatewayPorts" },
					{ name: "GlobalKnownHostsFile" },
					{ name: "GSSAPIAuthentication" },
					{ name: "GSSAPIDelegateCredentials" },
					{ name: "HashKnownHosts" },
					{ name: "Host" },
					{ name: "HostbasedAuthentication" },
					{ name: "HostKeyAlgorithms" },
					{ name: "HostKeyAlias" },
					{ name: "HostName" },
					{ name: "IdentityFile" },
					{ name: "IdentitiesOnly" },
					{ name: "IPQoS" },
					{ name: "KbdInteractiveAuthentication" },
					{ name: "KbdInteractiveDevices" },
					{ name: "KexAlgorithms" },
					{ name: "LocalCommand" },
					{ name: "LocalForward" },
					{ name: "LogLevel" },
					{ name: "MACs" },
					{ name: "NoHostAuthenticationForLocalhost" },
					{ name: "NumberOfPasswordPrompts" },
					{ name: "PasswordAuthentication" },
					{ name: "PermitLocalCommand" },
					{ name: "PKCS11Provider" },
					{ name: "Port" },
					{ name: "PreferredAuthentications" },
					{ name: "Protocol" },
					{ name: "ProxyCommand" },
					{ name: "PubkeyAuthentication" },
					{ name: "RekeyLimit" },
					{ name: "RequestTTY" },
					{ name: "RhostsRSAAuthentication" },
					{ name: "RSAAuthentication" },
					{ name: "SendEnv" },
					{ name: "ServerAliveInterval" },
					{ name: "ServerAliveCountMax" },
					{ name: "StrictHostKeyChecking" },
					{ name: "TCPKeepAlive" },
					{ name: "Tunnel" },
					{ name: "TunnelDevice" },
					{ name: "UsePrivilegedPort" },
					{ name: "User" },
					{ name: "UserKnownHostsFile" },
					{ name: "VerifyHostKeyDNS" },
					{ name: "VisualHostKey" },
					{ name: "XAuthLocation" }
				]
			}
		},
		{
			name: "-P",
			description: `Specifies the port to connect to on the remote host.  Note that
this option is written with a capital ‘P’, because -p is already
reserved for preserving the times and modes of the file`,
			args: { name: "port" }
		},
		{
			name: "-p",
			description: "Preserves modification times, access times, and modes from the original file"
		},
		{
			name: "-q",
			description: "Quiet mode: disables the progress meter as well as warning and diagnostic messages from ssh(1)"
		},
		{
			name: "-r",
			description: "Recursively copy entire directories.  Note that scp follows symbolic links encountered in the tree traversal"
		},
		{
			name: "-S",
			description: "Name of program to use for the encrypted connection.  The program must understand ssh(1) options",
			args: { name: "program" }
		},
		{
			name: "-T",
			description: `Disable strict filename checking.  By default when copying files
from a remote host to a local directory scp checks that the
received filenames match those requested on the command-line to
prevent the remote end from sending unexpected or unwanted files.
Because of differences in how various operating systems and shells
interpret filename wildcards, these checks may cause wanted files
to be rejected.  This option disables these checks at the expense
of fully trusting that the server will not send unexpected
filenames`
		},
		{
			name: "-v",
			description: "Verbose mode.  Causes scp and ssh(1) to print debugging messages about their progress. This is helpful in debugging connection, authentication, and configuration problems"
		}
	]
};
//#endregion
export { completionSpec as default };
