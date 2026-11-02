# MCP Tools Reference

> Implemented so far: `list_vms`, `list_running_vms`, `get_vm_info`, `get_vm_state`, `get_host_info`, `start_vm`, `shutdown_vm`, `pause_vm`, `resume_vm`, `save_vm_state`, `wait_for_vm_state`, `poweroff_vm`, `reset_vm`, `discard_saved_state`, `execute_command`, `execute_command_async`, `get_command_status`, `get_command_output`, `wait_for_command`, `get_command_history`, `cancel_command`, `detect_guest_os`, `list_available_shells`, `list_guest_files`, `read_guest_file`, `write_guest_file`, `delete_guest_file`. The rest of this page lists the planned tools, grouped by area, with their permission categories.

Categories: **R** read-only · **M** ordinary modification · **D** destructive (requires explicit approval).

| Area | Tools | Category | Backing manager |
|---|---|---|---|
| Discovery | `list_vms`, `list_running_vms`, `search_vms`, `inspect_vm`, `get_vm_info`, `get_vm_uuid`, `get_vm_state`, `get_vm_configuration`, `get_vm_hardware`, `get_vm_directory`, `get_host_info`, `get_virtualbox_version`, `get_virtualbox_installation`, `get_vm_boot_information` | R | VmManager (done) |
| Lifecycle | `start_vm`, `start_vm_headless`, `start_vm_gui`, `shutdown_vm`, `pause_vm`, `resume_vm`, `restart_vm`, `save_vm_state`, `wait_for_vm_state` | M | VmManager (done) |
| Lifecycle (forced) | `poweroff_vm`, `reset_vm`, `discard_saved_state` | D | VmManager (done) |
| Creation | `create_vm`, `clone_vm`, `duplicate_vm`, `modify_vm`, `rename_vm`, `register_vm`, `import_vm`, `export_vm` | M | VmManager (done) |
| Creation (destructive) | `delete_vm`, `unregister_vm` | D | VmManager (done) |
| Shell detection | `detect_guest_os`, `detect_guest_shell`, `list_available_shells`, `get_default_shell`, `select_guest_shell` | R | ConnectionManager (done) |
| Execution | `execute_command`, `execute_bash`, `execute_linux_shell`, `execute_powershell`, `execute_cmd`, `execute_*_script`, `execute_python_script`, `execute_command_async`, `execute_command_sequence`, `execute_parallel_commands`, `cancel_command` | M (D if the command is flagged) | ExecutionManager (done) |
| Execution status | `get_command_status`, `get_command_output`, `get_command_result`, `get_command_history`, `get_guest_environment` | R | ExecutionManager (done) |
| Terminals | `open_terminal_session`, `list_terminal_sessions`, `get_terminal_session`, `send_terminal_input`, `read_terminal_output`, `resize_terminal_session`, `interrupt_terminal_session`, `terminate_terminal_session`, `close_terminal_session` | M / R | TerminalManager (done) |
| Files | `list_guest_files`, `get_guest_file_info`, `read_guest_file`, `search_guest_files`, `calculate_file_checksum` | R | FileManager (done) |
| Files | `write_guest_file`, `create_guest_file`, `create_guest_directory`, `rename_guest_file`, `copy_guest_file`, `move_guest_file`, `upload_*`, `download_*` | M (D for protected paths) | FileManager (done) |
| Files | `delete_guest_file`, `delete_guest_directory` | M (D for protected paths) | FileManager (done) |
| Packages, administration, snapshots, networking, storage, devices, monitoring, groups, orchestration | See the project specification | Mixed | Planned |

Every command result includes the VM name and UUID, backend, shell, command, working directory, start and completion times, duration, exit code, stdout, stderr, status and timeout flag.
