!macro customInstall
  ; Kill any running instances before installation
  nsExec::ExecToLog 'taskkill /F /IM "Chrome MCP Tunnel.exe" /T'
  Pop $0
!macroend

!macro customUnInstall
  ; Kill any running instances before uninstallation  
  nsExec::ExecToLog 'taskkill /F /IM "Chrome MCP Tunnel.exe" /T'
  Pop $0
!macroend