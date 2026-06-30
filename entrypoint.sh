#!/bin/sh
# entrypoint.sh — eseguito come root al boot del container.
# Garantisce che /data esista e sia scrivibile dall'utente "node"
# (i named volumes Docker nascono con ownership root:root).
# Poi droppa i privilegi ed esegue il CMD.

set -e

mkdir -p /data
# -R per gestire volumi con contenuti pre-esistenti (es. backup ripristinati)
chown -R node:node /data

# su-exec droppa i privilegi ed esegue il CMD ricevuto.
exec su-exec node "$@"
