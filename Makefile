# Three.js walk demo — develop in WSL, view in the Windows browser.
PORT ?= 8000
URL  := http://127.0.0.1:$(PORT)/

.PHONY: demo help

## demo: host with python -m http.server and open the Windows browser
demo:
	@echo ">> serving $(URL)  (Ctrl+C to stop)"
	@( sleep 0.6; \
		if command -v powershell.exe >/dev/null 2>&1; then \
			powershell.exe -NoProfile -Command "Start-Process '$(URL)'"; \
		elif command -v cmd.exe >/dev/null 2>&1; then \
			(cd /mnt/c/Windows/System32 && cmd.exe /c start "" "$(URL)"); \
		elif command -v xdg-open >/dev/null 2>&1; then \
			xdg-open "$(URL)"; \
		fi ) >/dev/null 2>&1 &
	python3 -m http.server $(PORT)

## help: list targets
help:
	@grep -E '^## ' Makefile | sed 's/^## //'
