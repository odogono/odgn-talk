# Compiles each statement with EXPLAIN on an empty in-memory database, with and
# without a schema, logging the authorizer actions seen. Run: python3 -I spike.py
import sqlite3
print("sqlite", sqlite3.sqlite_version)
def check(sql, schema=None):
    con = sqlite3.connect(":memory:")
    if schema: con.executescript(schema)
    log = []
    def auth(action, a1, a2, db, trig):
        log.append((action, a1, a2))
        return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_PRAGMA) else sqlite3.SQLITE_OK
    con.set_authorizer(auth)
    try:
        con.execute("EXPLAIN " + sql)  # compiles without running
        r = "ok"
    except Exception as e:
        r = f"{type(e).__name__}: {e}"
    acts = sorted({a for a,_,_ in log})
    print(f"{sql!r:55} schema={'y' if schema else 'n'} -> {r}; actions={acts}")
S = "create table t(id integer primary key, name text);"
for q in ["selec 1", "select name from t", "delete from t", "select 1; select 2",
          "attach 'x' as y", "pragma table_info(t)", "select nosuch from t",
          "insert into t(name) values (?) returning id"]:
    check(q); check(q, S)
