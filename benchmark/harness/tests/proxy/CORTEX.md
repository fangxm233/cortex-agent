Update this file whenever this directory changes

Proxy tests prove host credential isolation, policy enforcement, and Docker egress containment.

| filename | role | function |
|---|---|---|
| synthetic.py | fixture | Runs the synthetic model upstream |
| docker_tools.py | fixture | Creates isolated trial networks and containers |
| test_proxy.py | test | Verifies forwarding, budgets, deadlines, and logs |
| test_container_boundary.py | test | Proves source and egress containment in Docker |
| test_proxy_manifest.py | test | Verifies the credential-free proxy manifest block |
| test_cli.py | test | Verifies the module command interface |
