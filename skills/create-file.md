---
name: create-file
description: Create a file with specified content
when-to-use: When you need to create a new file
arguments: [filepath, content]
allowed-tools:
  - Write
---

# Create File Skill

Create a file at the specified path with the given content.

**Filepath**: $FILEPATH
**Content**: $CONTENT

Use the Write tool to create the file at $FILEPATH with content: $CONTENT
