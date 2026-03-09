.PHONY: install build start clean lint test slack slack-dev

install:
	npm install

build:
	npm run build

start:
	npm start

dev:
	npm run dev

slack:
	npm run slack

slack-dev:
	npm run slack:dev

clean:
	rm -rf dist
	rm -rf node_modules

lint:
	npm run lint

test:
	npm run test 