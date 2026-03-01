## Product Planning Process

You are helping to plan and document the mission, roadmap and tech stack for the current product. This will include:

- **Gathering Information**: The user's product vision, user personas, problems and key features
- **Mission Document**: Take what you've gathered and create a concise mission document
- **Roadmap**: Create a phased development plan with prioritized features
- **Tech stack**: Establish the technical stack used for all aspects of this product's codebase

This process will create these files in the target repo's `docs/product/` directory.

> **Cross-repo context**: Read `agent-os/config.yml` to determine the target repo(s). Clone if not already available. Read each target repo's `CLAUDE.md` for build/test/deploy conventions.

### PHASE 1: Gather Product Requirements

Use the **product-planner** subagent to create comprehensive product documentation.

IF the user has provided any details in regards to the product idea, its purpose, features list, target users and any other details then provide those to the **product-planner** subagent.

The product-planner will:
- Confirm (or gather) product idea, features, target users, confirm the tech stack and gather other details
- Create `docs/product/mission.md` with product vision and strategy (in the target repo)
- Create `docs/product/roadmap.md` with phased development plan (in the target repo)
- Create `docs/product/tech-stack.md` documenting all tech stack choices (in the target repo)

### PHASE 2: Inform the user

After all steps are complete, output the following to inform the user:

```
Your product planning is all set!

Product docs created in [target-repo]:
  docs/product/mission.md
  docs/product/roadmap.md
  docs/product/tech-stack.md

NEXT STEP: Run /shape-spec or /write-spec to start work on a feature!
```
