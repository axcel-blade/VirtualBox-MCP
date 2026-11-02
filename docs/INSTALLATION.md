# Installation

## Prerequisites

- Node.js 20 LTS or newer
- Oracle VirtualBox 6.0 or newer (developed against 7.2)

The server finds `VBoxManage` automatically using `VBOX_MSI_INSTALL_PATH`, `VBOX_INSTALL_PATH`, `PATH` and the standard install locations:

| Host | Default location |
|---|---|
| Windows | `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe` |
| macOS | `/Applications/VirtualBox.app/Contents/MacOS/VBoxManage` |
| Linux | `/usr/bin/VBoxManage`, `/usr/lib/virtualbox/VBoxManage` |

If yours is somewhere else, set `VBOX_MCP_VBOXMANAGE_PATH` or `virtualbox.executablePath`.

## From source

```bash
npm install
```

```bash
npm run build
```

## From npm (after the first release)

```bash
npm install -g virtualbox-mcp
```

## MCP client configuration (STDIO)

The STDIO entry point is still being built. Once it is available, this is the intended client configuration:

```json
{
  "mcpServers": {
    "virtualbox": {
      "command": "node",
      "args": ["/path/to/virtualbox-mcp/dist/index.js"],
      "env": { "VBOX_MCP_STAGING_DIRS": "/path/to/staging" }
    }
  }
}
```
