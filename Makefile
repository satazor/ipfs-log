all: build

deps:
	npm install

test: deps
	npm run test
	npm run test:browser
	
build: test
	npm run build
	@echo "Build success!"
	@echo "Built: 'dist/', 'examples/browser/'"

clean:
	rm package-lock.json
	rm -rf ipfs/
	rm -rf ipfs-log-benchmarks/
	rm -rf node_modules/
	rm -rf coverage/
	rm -rf test/keystore/

clean-dependencies: clean
	if [ -a package-lock.json ]; then rm package-lock.json; fi;

rebuild: | clean-dependencies build
	
.PHONY: test
