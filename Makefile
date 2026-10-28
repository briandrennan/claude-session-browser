.PHONY: build web run dev

build: web
	go build -o bin/csb ./cmd/csb

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

run: build
	./bin/csb -config config.yml

# Backend on :8484 plus Vite dev server on :5173 (proxies /api).
dev:
	go run ./cmd/csb -config config.yml & cd web && pnpm dev
