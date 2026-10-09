#!/bin/bash
set -e

# Garante que o token seja removido do package.json mesmo em caso de erro
cleanup() {
  if grep -q '"token"' package.json 2>/dev/null; then
    echo "🧹 Limpando token do package.json..."
    jq 'del(.build.publish.token)' package.json > package.tmp.json && mv package.tmp.json package.json
  fi
}
trap cleanup EXIT

# ─── Parse de argumentos ──────────────────────────────────────────────────────
#   --no-publish | --dry-run : compila localmente sem publicar no GitHub nem
#                              registrar no banco (não exige GITHUB_TOKEN nem .env).
#   major | minor | patch    : parte da versão a incrementar (default: patch).
NO_PUBLISH=0
VERSION_PART="patch"
for arg in "$@"; do
  case "$arg" in
    --no-publish|--dry-run) NO_PUBLISH=1 ;;
    major|minor|patch)      VERSION_PART="$arg" ;;
    *) echo "⚠️  Argumento ignorado: $arg" ;;
  esac
done

# ─── Token do GitHub (não exigido em --no-publish) ───────────────────────────
TOKEN_VALUE=$GITHUB_TOKEN
if [ "$NO_PUBLISH" -eq 0 ] && [ -z "$TOKEN_VALUE" ]; then
  echo "❌ Erro: GITHUB_TOKEN não está definido no ambiente."
  echo "   Execute: export GITHUB_TOKEN=seu_token_aqui"
  exit 1
fi

# ─── Credenciais do banco (lidas do .env do backend; pulado em --no-publish) ──
# ⚠️ O caminho mudou na virada para o NestJS (08/10/2026): o Adonis foi para
# `arquivo/backend/` e a produção é o `backend-novo/`. O script apontava para
# `~/Sites/maximushub.com.br/backend/.env`, que deixou de existir — e a falha
# só apareceria no meio de uma publicação. Tenta os dois, na ordem do que é
# produção hoje.
BACKEND_ENV=""
for candidato in \
  ~/Sites/maximushub.com.br/backend-novo/.env \
  ~/Sites/maximushub.com.br/arquivo/backend/.env \
  ~/Sites/maximushub.com.br/backend/.env ; do
  if [ -f "$candidato" ]; then BACKEND_ENV="$candidato"; break; fi
done
if [ "$NO_PUBLISH" -eq 0 ] && [ -z "$BACKEND_ENV" ]; then
  echo "❌ Nenhum .env de backend encontrado (backend-novo, arquivo/backend)."
  exit 1
fi

DB_HOST=$(grep '^DB_HOST='     "$BACKEND_ENV" | cut -d'=' -f2 | tr -d '"')
DB_PORT=$(grep '^DB_PORT='     "$BACKEND_ENV" | cut -d'=' -f2 | tr -d '"')
DB_USER=$(grep '^DB_USER='     "$BACKEND_ENV" | cut -d'=' -f2 | tr -d '"')
DB_PASSWORD=$(grep '^DB_PASSWORD=' "$BACKEND_ENV" | cut -d'=' -f2 | tr -d '"')
DB_DATABASE=$(grep '^DB_DATABASE=' "$BACKEND_ENV" | cut -d'=' -f2 | tr -d '"')

DB_PORT=${DB_PORT:-3306}

mysql_exec() {
  MYSQL_PWD="$DB_PASSWORD" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_DATABASE" \
    --skip-column-names -s -e "$1"
}

# ─── Incremento de versão ─────────────────────────────────────────────────────
increment_version() {
  local version=$1
  local part=${2:-"patch"}
  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  major=${major:-0}; minor=${minor:-0}; patch=${patch:-0}
  case $part in
    major) ((major++)); minor=0; patch=0 ;;
    minor) ((minor++)); patch=0 ;;
    patch) ((patch++)) ;;
  esac
  echo "$major.$minor.$patch"
}

CURRENT_VERSION=$(node -p "require('./package.json').version")

# ─── Modo build local (--no-publish): compila sem bump, sem token, sem DB ─────
if [ "$NO_PUBLISH" -eq 1 ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  🧪 MaximusHub Print Client — Build LOCAL (--no-publish)"
  echo "  Versão       : $CURRENT_VERSION (sem incremento)"
  echo "  Publicação   : desabilitada (não toca no GitHub nem no banco)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "🚀 Compilando localmente (electron-builder --win --x64, publish never)..."
  npm run build:win
  echo ""
  echo "✅ Build local concluído. Artefatos em: $(pwd)/dist/"
  exit 0
fi

NEW_VERSION=$(increment_version "$CURRENT_VERSION" "$VERSION_PART")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🖨  MaximusHub Print Client — Build & Release"
echo "  Versão atual : $CURRENT_VERSION"
echo "  Nova versão  : $NEW_VERSION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Atualiza versão no package.json ─────────────────────────────────────────
echo "🔹 Atualizando versão no package.json..."
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.tmp.json && mv package.tmp.json package.json

# ─── Injeta token no publish temporariamente ─────────────────────────────────
echo "🔹 Adicionando token ao package.json temporariamente..."
jq --arg token "$TOKEN_VALUE" '.build.publish.token = $token' package.json > package.tmp.json && mv package.tmp.json package.json

# ─── Build e publicação ───────────────────────────────────────────────────────
echo ""
echo "🚀 Compilando e publicando no GitHub..."
npm run packagePublish

echo ""
echo "✅ Build concluído! Versão $NEW_VERSION publicada no GitHub."

# ─── Atualizar banco de dados ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📦 Registrar versão no banco de dados"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

DOWNLOAD_URL="https://github.com/leorobaskievicz/maximus-printer-client/releases/download/v${NEW_VERSION}/MHubPrintClient-Setup-${NEW_VERSION}.exe"

read -rp "Notas de release (Enter para pular): " RELEASE_NOTES

echo ""
echo "  Tipo de atualização:"
echo "  1) Opcional  — client atualiza automaticamente em background"
echo "  2) Obrigatória — exibe diálogo forçando a atualização"
echo ""
read -rp "Escolha [1/2]: " TIPO

IS_REQUIRED=0
if [ "$TIPO" = "2" ]; then
  IS_REQUIRED=1
fi

# Escapa aspas simples nas notas de release
RELEASE_NOTES_ESC="${RELEASE_NOTES//\'/\'\'}"

mysql_exec "
  INSERT INTO printer_client_versions (version, is_required, release_notes, download_url, created_at, updated_at)
  VALUES (
    '$NEW_VERSION',
    $IS_REQUIRED,
    '$RELEASE_NOTES_ESC',
    '$DOWNLOAD_URL',
    NOW(), NOW()
  );
"

echo ""
echo "✅ Versão $NEW_VERSION registrada no banco de dados."
echo ""
echo "🎉 Processo concluído!"
echo "   → GitHub Release: https://github.com/leorobaskievicz/maximus-printer-client/releases/tag/v${NEW_VERSION}"
echo "   → Download direto: $DOWNLOAD_URL"
