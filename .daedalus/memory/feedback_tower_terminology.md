---
name: Babelr instances are called Towers
description: A Babelr deployment/instance is called a Tower — distinguishes from in-app "servers" which are Group actors (like Discord servers)
type: feedback
originSessionId: 173c999b-e4bd-4c2c-b113-6b1a648ba383
---
A Babelr instance (the deployment, the running Docker container, the thing at chat.example.com) is called a **Tower**.

**Why:** "Server" already means something inside the application — it's a Group actor, like a Discord server, with channels and members. Calling the instance a "server" too creates confusion ("join my server" vs "deploy a server"). Tower ties back to the Tower of Babel name and is immediately evocative.

**How to apply:** Use "Tower" in user-facing docs, UI, and conversation when referring to the instance/deployment. Use "server" only for the in-app Group concept. Examples:
- "Deploy your own Tower" not "Deploy your own server"
- "Federate with another Tower" not "Federate with another instance"
- "Your Tower at chat.example.com" not "Your instance at chat.example.com"
- "Tower admin settings" for instance-level config, "Server settings" for Group-level config
