# Script PowerShell para criar tabelas no PostgreSQL do Render
Write-Host "Conectando ao banco de dados PostgreSQL do Render..." -ForegroundColor Cyan
Write-Host "Criando tabelas do sistema de autenticacao..." -ForegroundColor Cyan
Write-Host ""

$env:PGPASSWORD = "amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho"

psql -h dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com -U intranet_db_yd0w_user intranet_db_yd0w -f schema.sql

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Tabelas criadas com sucesso!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Erro ao criar tabelas. Verifique se o psql esta instalado." -ForegroundColor Red
}

Read-Host "Pressione Enter para sair"
