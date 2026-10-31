.PHONY: build web run dev

# Ports: `make run PORT=9090`, `make dev PORT=9090 WEB_PORT=5174`. PORT overrides
# config.yml's listen (binds 127.0.0.1); WEB_PORT is the Vite dev server (default 5173).
WEB_PORT ?= 5173
LISTEN = $(if $(PORT),-listen $(PORT))

build: web
	go build -o bin/csb ./cmd/csb

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

run: build
	./bin/csb -config config.yml $(LISTEN)

# Backend on :8484 (or PORT) plus Vite dev server on :WEB_PORT, which proxies /api to the backend.
dev:
	go run ./cmd/csb -config config.yml $(LISTEN) & cd web && CSB_PORT=$(or $(PORT),8484) pnpm dev --port $(WEB_PORT) --strictPort
