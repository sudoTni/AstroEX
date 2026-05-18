#!/bin/bash

timecode=$(date +"%Y%m%d%H%M%S")
logfile="/home/michael/dev/AstroEX/logs/master_log_$timecode.log"

cd /home/michael/dev/AstroEX
find data/ -mindepth 1 -maxdepth 1 ! -name 'jobDB.json' -exec rm -rfv {} \;
rm -rfv logs/* materials/*

exec > $logfile 2>&1

npm run scrape:search -- -s3 --locations '["","Albany, NY"]'

npm run process

npm run job:cloth -- --verbose --log-payload --preset "jc_gf25_poe" --api-key "kpoIpD1zGMOWyqrP4bAUvTRErAYWzKJgjesMn_R0Fi8" -s5 --batch 50

npm run scrape:jobs -- -s3

npm run job:judge -- --verbose --log-payload --preset "jep_gf25_poe" --api-key "kpoIpD1zGMOWyqrP4bAUvTRErAYWzKJgjesMn_R0Fi8" -s5

npm run makeMaterials -- --verbose --log-payload --preset "rop_g5_poe" --api-key "kpoIpD1zGMOWyqrP4bAUvTRErAYWzKJgjesMn_R0Fi8" -s5

mkdir -p ~/dev/AstroEX/materials-deployed/
find ~/dev/AstroEX/materials/ -name "*.txt" -exec rclone -v --fast-list copy {} GoogleDrive:/autoJobGen-src/ \;
mv -v ~/dev/AstroEX/materials/* ~/dev/AstroEX/materials-deployed/

