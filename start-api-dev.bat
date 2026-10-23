@echo off
cd /d "C:\Users\shuan\Documents\GitHub\datafoundry"
set ONTOLOGY_SERVICE_TOKEN=f4bf773c0038d7ad367c598e9be2637b9820c303312c1a9d3be522d3b6b2de0a
set METADATA_DB_PATH=C:\Users\shuan\Documents\GitHub\datafoundry\apps\api\storage\metadata\workbench.sqlite
set AUTH_SESSION_SECRET=fusion-smoke-session-secret-32b!!
set AUTH_PUBLIC_BASE_URL=http://127.0.0.1:3000
set AUTH_EMAIL_DELIVERY=test
set AUTH_REGISTRATION_MODE=open
set STORAGE_ROOT_DIR=C:\Users\shuan\Documents\GitHub\datafoundry\apps\api\storage
if not exist "%STORAGE_ROOT_DIR%\metadata" mkdir "%STORAGE_ROOT_DIR%\metadata"
node_modules\.bin\tsx apps\api\src\index.ts
