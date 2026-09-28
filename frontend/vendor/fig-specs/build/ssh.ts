// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "ssh",
  "description": "Log into a remote machine",
  "options": [
    {
      "names": [
        "-1"
      ],
      "description": "Forces ssh to try protocol version 1 only"
    },
    {
      "names": [
        "-2"
      ],
      "description": "Forces ssh to try protocol version 2 only"
    },
    {
      "names": [
        "-4"
      ],
      "description": "Forces ssh to use IPv4 addresses only"
    },
    {
      "names": [
        "-6"
      ],
      "description": "Forces ssh to use IPv6 addresses only"
    },
    {
      "names": [
        "-A"
      ],
      "description": "Enables forwarding of the authentication agent connection"
    },
    {
      "names": [
        "-a"
      ],
      "description": "Disables forwarding of the authentication agent connection"
    },
    {
      "names": [
        "-b"
      ],
      "description": "Use bind_address on the local machine as the source address of the connection",
      "args": {
        "name": "bind address",
        "description": "Source address of the connection"
      }
    },
    {
      "names": [
        "-C"
      ],
      "description": "Requests compression of all data (including stdin, stdout, stderr, and data for forwarded X11 and TCP connections)"
    },
    {
      "names": [
        "-c"
      ],
      "description": "Selects the cipher specification for encrypting the session",
      "args": {
        "name": "cipher spec",
        "description": "The selected cipher specification"
      }
    },
    {
      "names": [
        "-D"
      ],
      "description": "Specifies a local 'dynamic' application-level port forwarding",
      "args": {
        "name": "port",
        "description": "Port of the bind address"
      }
    },
    {
      "names": [
        "-e"
      ],
      "description": "Sets the escape character for sessions with a pty (default: '~')",
      "args": {
        "name": "escape char",
        "description": "Specified escape character"
      }
    },
    {
      "names": [
        "-F"
      ],
      "description": "Specifies an alternative per-user configuration file",
      "args": {
        "name": "configfile",
        "description": "Path to alternative config file"
      }
    },
    {
      "names": [
        "-f"
      ],
      "description": "Requests ssh to go to background just before command execution"
    },
    {
      "names": [
        "-g"
      ],
      "description": "Allows remote hosts to connect to local forwarded ports"
    },
    {
      "names": [
        "-I"
      ],
      "description": "Specify the PKCS#11 shared library ssh should use to communicate with a PKCS#11 token providing the user's private RSA key",
      "args": {
        "name": "pkcs11"
      }
    },
    {
      "names": [
        "-i"
      ],
      "description": "Selects a file from which the identity (private key) for public key authentication is read",
      "args": {
        "name": "identity file",
        "description": "Path to identity (private key)"
      },
      "isRepeatable": true
    },
    {
      "names": [
        "-K"
      ],
      "description": "Enables GSSAPI-based authentication and forwarding (delegation) of GSSAPI credentials to the server"
    },
    {
      "names": [
        "-k"
      ],
      "description": "Disables forwarding (delegation) of GSSAPI credentials to the server"
    },
    {
      "names": [
        "-L"
      ],
      "description": "Specifies that the given port on the local (client) host is to be forwarded to the given host and port on the remote side",
      "args": {
        "name": "port:host:hostport",
        "description": "Local port, followed by host and host port to forward to"
      }
    },
    {
      "names": [
        "-l"
      ],
      "description": "Specifies the user to log in as on the remote machine",
      "args": {
        "name": "login name",
        "description": "Name of user logging into remote machine"
      }
    },
    {
      "names": [
        "-M"
      ],
      "description": "Places the ssh client into ``master'' mode for connection sharing",
      "isRepeatable": true
    },
    {
      "names": [
        "-m"
      ],
      "description": "Additionally, for protocol version 2 a comma-separated list of MAC (message authentication code) algorithms can be specified in order of preference",
      "args": {
        "name": "mac spec"
      }
    },
    {
      "names": [
        "-N"
      ],
      "description": "Do not execute a remote command"
    },
    {
      "names": [
        "-n"
      ],
      "description": "Redirects stdin from /dev/null (actually, prevents reading from stdin)"
    },
    {
      "names": [
        "-O"
      ],
      "description": "Control an active connection multiplexing master process",
      "args": {
        "name": "ctl cmd",
        "description": "Command that's passed to the master process"
      }
    },
    {
      "names": [
        "-o"
      ],
      "description": "Can be used to give options in the format used in the configuration file",
      "args": {
        "name": "option",
        "description": "Options that can be specified in the format of the config file",
        "suggestions": [
          "AddressFamily",
          "BatchMode",
          "BindAddress",
          "ChallengeResponseAuthentication",
          "CheckHostIP",
          "Cipher",
          "Ciphers",
          "ClearAllForwardings",
          "Compression",
          "CompressionLevel",
          "ConnectionAttempts",
          "ConnectTimeout",
          "ControlMaster",
          "ControlPath",
          "ControlPersist",
          "DynamicForward",
          "EscapeChar",
          "ExitOnForwardFailure",
          "ForwardAgent",
          "ForwardX11",
          "ForwardX11Timeout",
          "ForwardX11Trusted",
          "GatewayPorts",
          "GlobalKnownHostsFile",
          "GSSAPIAuthentication",
          "GSSAPIDelegateCredentials",
          "HashKnownHosts",
          "Host",
          "HostbasedAuthentication",
          "HostKeyAlgorithms",
          "HostKeyAlias",
          "HostName",
          "IdentityFile",
          "IdentitiesOnly",
          "IPQoS",
          "KbdInteractiveAuthentication",
          "KbdInteractiveDevices",
          "KexAlgorithms",
          "LocalCommand",
          "LocalForward",
          "LogLevel",
          "MACs",
          "NoHostAuthenticationForLocalhost",
          "NumberOfPasswordPrompts",
          "PasswordAuthentication",
          "PermitLocalCommand",
          "PKCS11Provider",
          "Port",
          "PreferredAuthentications",
          "Protocol",
          "ProxyCommand",
          "PubkeyAuthentication",
          "RekeyLimit",
          "RequestTTY",
          "RhostsRSAAuthentication",
          "RSAAuthentication",
          "SendEnv",
          "ServerAliveInterval",
          "ServerAliveCountMax",
          "StrictHostKeyChecking",
          "TCPKeepAlive",
          "Tunnel",
          "TunnelDevice",
          "UsePrivilegedPort",
          "User",
          "UserKnownHostsFile",
          "VerifyHostKeyDNS",
          "VisualHostKey",
          "XAuthLocation"
        ]
      },
      "isRepeatable": true
    },
    {
      "names": [
        "-p"
      ],
      "description": "Port to connect to on the remote host",
      "args": {
        "name": "port",
        "description": "Port to connect to"
      }
    },
    {
      "names": [
        "-q"
      ],
      "description": "Quiet mode.  Causes most warning and diagnostic messages to be suppressed"
    },
    {
      "names": [
        "-R"
      ],
      "description": "Specifies that the given port on the remote (server) host is to be forwarded to the given host and port on the local side",
      "args": {
        "name": "port:host:hostport",
        "description": "Local port, followed by host and host port to forward to"
      }
    },
    {
      "names": [
        "-S"
      ],
      "description": "Specifies the location of a control socket for connection sharing, or the string 'none' to disable connection sharing",
      "args": {
        "name": "ctl_path",
        "description": "Location of the control socket"
      }
    },
    {
      "names": [
        "-s"
      ],
      "description": "May be used to request invocation of a subsystem on the remote system"
    },
    {
      "names": [
        "-T"
      ],
      "description": "Disable pseudo-tty allocation"
    },
    {
      "names": [
        "-t"
      ],
      "description": "Force pseudo-tty allocation",
      "isRepeatable": true
    },
    {
      "names": [
        "-V"
      ],
      "description": "Display the version number and exit"
    },
    {
      "names": [
        "-v"
      ],
      "description": "Verbose mode.  Causes ssh to print debugging messages about its progress"
    },
    {
      "names": [
        "-W"
      ],
      "description": "Requests that standard input and output on the client be forwarded to host on port over the secure channel",
      "args": {
        "name": "host:port",
        "description": "Host and port to forward to"
      }
    },
    {
      "names": [
        "-w"
      ],
      "description": "Requests tunnel device forwarding with the specified tun(4) devices between the client (local_tun) and the server (remote_tun)",
      "args": {
        "name": "local tun",
        "description": "Local device to forward to"
      }
    },
    {
      "names": [
        "-X"
      ],
      "description": "Enables X11 forwarding"
    },
    {
      "names": [
        "-x"
      ],
      "description": "Disables X11 forwarding"
    },
    {
      "names": [
        "-Y"
      ],
      "description": "Enables trusted X11 forwarding"
    },
    {
      "names": [
        "-y"
      ],
      "description": "Send log information using the syslog(3) system module"
    }
  ],
  "args": [
    {
      "name": "user@hostname",
      "description": "Address of remote machine to log into"
    }
  ]
};
