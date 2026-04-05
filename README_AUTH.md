# Sistema de Autenticação - Munchkin Digital

Sistema completo de login e cadastro de usuários integrado com PostgreSQL no Render.

## 📋 O que foi criado

### 1. Banco de Dados
- **Arquivo**: `database/schema.sql`
- **Tabela**: `mtkin.users` com:
  - `id`, `username`, `email`, `password_hash`
  - `is_admin` (coluna para definir administradores)
  - `created_at`, `last_login`, `active`

### 2. Backend (API)
- **Pasta**: `backend/`
- **Arquivos**:
  - `server.js` - API Express com rotas de autenticação
  - `package.json` - Dependências do Node.js
  - `.env` - Configurações do banco de dados

- **Endpoints**:
  - `POST /api/register` - Cadastro de novos usuários
  - `POST /api/login` - Login de usuários
  - `GET /api/verify` - Verificação de token JWT
  - `POST /api/logout` - Logout
  - `GET /api/health` - Status da API

### 3. Frontend
- **Modal de autenticação** adicionado ao `index.html`
- **Estilos** adicionados ao `styles.css`
- **JavaScript** para integração com a API

## 🚀 Como usar

### Passo 1: Criar as tabelas no banco de dados

1. Acesse o painel do Render: https://dashboard.render.com/
2. Abra seu banco de dados PostgreSQL
3. Vá em **"Connect"** e clique em **"PSQL Command"** ou use um cliente SQL
4. Execute o conteúdo do arquivo `database/schema.sql`

```sql
-- Copie e execute todo o conteúdo do arquivo schema.sql
```

### Passo 2: Instalar dependências do backend

Abra o terminal na pasta `backend/` e execute:

```powershell
cd backend
npm install
```

### Passo 3: Iniciar o servidor backend

No terminal (ainda na pasta `backend/`):

```powershell
npm start
```

Ou para desenvolvimento com auto-reload:

```powershell
npm run dev
```

O servidor vai rodar em: `http://localhost:3000`

### Passo 4: Abrir o frontend

1. Abra o arquivo `index.html` com Live Server
2. O modal de login aparecerá automaticamente
3. Cadastre um novo usuário ou faça login

## 👤 Criar usuário administrador

### Opção 1: Via SQL (depois de criar um usuário pelo site)

```sql
-- Tornar um usuário existente em admin
UPDATE mtkin.users 
SET is_admin = true 
WHERE username = 'seu_usuario';
```

### Opção 2: Via SQL (criar admin direto)

```sql
-- Criar usuário admin com senha: admin123
-- IMPORTANTE: Trocar a senha após primeiro login!
INSERT INTO mtkin.users (username, email, password_hash, is_admin) 
VALUES (
  'admin', 
  'admin@munchkin.com', 
  '$2b$10$rBV2kKUBN7PQ5Gz7xGxvY.FwK6pU6OhQxL5qhN5qxR5qQXm5qN5qR', 
  true
);
```

## 🔐 Segurança

- Senhas são criptografadas com **bcrypt**
- Autenticação via **JWT (JSON Web Token)**
- Token expira em 24 horas
- Validação de dados com **express-validator**
- Conexão SSL com banco de dados

## 🛠️ Tecnologias utilizadas

- **Backend**: Node.js + Express
- **Banco de dados**: PostgreSQL (Render)
- **Autenticação**: JWT + bcrypt
- **Frontend**: HTML5 + CSS3 + JavaScript

## 📝 Notas importantes

1. **JWT_SECRET**: Em produção, troque a chave no arquivo `.env` por uma chave forte e aleatória
2. **CORS**: Atualmente configurado para aceitar todas as origens. Em produção, configure apenas domínios permitidos
3. **HTTPS**: Em produção, use HTTPS para todas as requisições
4. **Validação**: O sistema valida:
   - Username: 3-50 caracteres
   - Email: formato válido
   - Senha: mínimo 6 caracteres

## 🐛 Solução de problemas

### Erro de conexão com banco de dados
- Verifique se as credenciais no `.env` estão corretas
- Confirme que o banco de dados do Render está ativo

### Modal não aparece
- Abra o Console do navegador (F12) e verifique erros
- Confirme que o servidor backend está rodando

### "Erro de conexão" ao fazer login/cadastro
- Verifique se o servidor backend está rodando em `http://localhost:3000`
- Veja se há erros no terminal do servidor

## 📞 Próximos passos

Agora que o sistema de autenticação está pronto, você pode:
- Criar rotas protegidas (que exigem login)
- Adicionar funcionalidades exclusivas para admins
- Implementar recuperação de senha
- Adicionar mais campos ao perfil do usuário
