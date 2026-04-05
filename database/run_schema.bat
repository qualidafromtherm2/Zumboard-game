@echo off
echo Conectando ao banco de dados PostgreSQL do Render...
echo Criando tabelas do sistema de autenticacao...
echo.

set PGPASSWORD=amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho
psql -h dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com -U intranet_db_yd0w_user intranet_db_yd0w -f schema.sql

echo.
echo Tabelas criadas!
pause
