```markdown
# FaceScrap Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the FaceScrap repository, a TypeScript project with no detected framework. You'll learn how to structure files, write imports/exports, and follow commit and testing conventions. This guide also provides suggested commands for common workflows to streamline your development process.

## Coding Conventions

### File Naming
- Use **kebab-case** for all file names.
  - Example: `face-scrap-utils.ts`, `user-profile.test.ts`

### Import Style
- Mixed import styles are used. Both default and named imports may appear.
  - Example:
    ```typescript
    import fs from 'fs';
    import { parseImage } from './image-utils';
    ```

### Export Style
- Prefer **named exports**.
  - Example:
    ```typescript
    // Good
    export function analyzeFace(data: Buffer): FaceData { ... }

    // Avoid default exports
    // export default function analyzeFace(...) { ... }
    ```

### Commit Patterns
- Commit messages are **freeform**, sometimes prefixed (e.g., `security:`).
- Average commit message length: 43 characters.
  - Example:
    ```
    security: sanitize user input before processing
    Update face detection algorithm for speed
    ```

## Workflows

_No explicit workflows detected in the repository._

## Testing Patterns

- Test files use the `.test.ts` suffix.
  - Example: `face-detection.test.ts`
- Testing framework is **unknown**; check existing test files for patterns.
- Example test file structure:
  ```typescript
  import { detectFaces } from './face-detection';

  describe('detectFaces', () => {
    it('should return faces for a valid image', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command | Purpose |
|---------|---------|
| /run-tests | Run all `.test.ts` files to verify code correctness |
| /lint | Lint the codebase for style and errors (if linter is configured) |
| /commit [message] | Make a commit following the freeform or `security:` prefix pattern |
```