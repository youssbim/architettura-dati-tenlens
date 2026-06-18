#!/usr/bin/env bash
# Inizializza il cluster shardato con NSHARDS shard (default 1) AGGIUNTI PRIMA
# di shardCollection: così l'hashed pre-splitta sui nodi e i dati si distribuiscono
# ALL'INSERIMENTO (niente migrazione del balancer, niente documenti orfani →
# misure pulite). Per la curva 1→…→N si ricrea il cluster con NSHARDS diverso.
set -e
H=host.docker.internal
N=${NSHARDS:-1}
PORTS=(27041 27042 27043 27044 27045)               # fino a 5 shard
SHARDS=$(for i in $(seq 1 "$N"); do echo -n "shard$i "; done)

echo "→ attendo i nodi…"
for n in cfg $SHARDS; do
  until docker exec garagraph-shard-$n-1 mongosh --quiet --port 27017 --eval "db.adminCommand('ping').ok" 2>/dev/null | grep -q 1; do sleep 2; done
done

echo "→ init config RS + shard RS"
docker exec garagraph-shard-cfg-1 mongosh --quiet --port 27017 --eval "rs.initiate({_id:'cfg', configsvr:true, members:[{_id:0,host:'$H:27040'}]})" >/dev/null 2>&1 || true
for i in $(seq 1 "$N"); do
  p=${PORTS[$((i-1))]}
  docker exec garagraph-shard-shard$i-1 mongosh --quiet --port 27017 --eval "rs.initiate({_id:'shard$i', members:[{_id:0,host:'$H:$p'}]})" >/dev/null 2>&1 || true
done

echo "→ attendo le elezioni…"
for n in cfg $SHARDS; do
  until docker exec garagraph-shard-$n-1 mongosh --quiet --port 27017 --eval "rs.hello().isWritablePrimary" 2>/dev/null | grep -q true; do sleep 2; done
done
until docker exec garagraph-shard-mongos-1 mongosh --quiet --port 27017 --eval "db.adminCommand('ping').ok" 2>/dev/null | grep -q 1; do sleep 2; done

echo "→ chunksize=1MB + addShard×$N (PRIMA di shardCollection) + shardCollection bench.lotti {cig:hashed}"
ADD=""
for i in $(seq 1 "$N"); do p=${PORTS[$((i-1))]}; ADD="$ADD sh.addShard('shard$i/$H:$p');"; done
docker exec garagraph-shard-mongos-1 mongosh --quiet --port 27017 --eval "
db.getSiblingDB('config').settings.updateOne({_id:'chunksize'},{\$set:{value:1}},{upsert:true});
$ADD
sh.enableSharding('bench');
sh.shardCollection('bench.lotti', {cig:'hashed'});
print('shard attivi: ' + db.adminCommand({listShards:1}).shards.map(s=>s._id).join(', '));
"
echo "✓ cluster pronto con $N shard (pre-split)."
