podman run --rm --init --shm-size=2g -v /mnt/toshiba/Projects/HeyAgent/spikes/browser:/opt/browser/spike:ro -w /opt/browser/spike localhost/heyagent-browser-base:m0 node t-sandbox.mjs
