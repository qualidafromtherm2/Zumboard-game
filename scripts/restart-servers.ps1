# Restart frontend (3 ports) + backend servers.

$ports = 5500, 5501, 5502, 3000
foreach ($p in $ports) {
  Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

Start-Sleep -Milliseconds 500

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectRoot ".venv/Scripts/python.exe"

Start-Process -FilePath $pythonExe -ArgumentList "-m", "http.server", "5500" -WorkingDirectory $projectRoot -NoNewWindow
Start-Process -FilePath $pythonExe -ArgumentList "-m", "http.server", "5501" -WorkingDirectory $projectRoot -NoNewWindow
Start-Process -FilePath $pythonExe -ArgumentList "-m", "http.server", "5502" -WorkingDirectory $projectRoot -NoNewWindow
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory (Join-Path $projectRoot "backend") -NoNewWindow
