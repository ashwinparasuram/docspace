export interface TemplatePage {
  title: string;
  kind?: 'doc' | 'group' | 'link';
  icon?: string;
  description?: string;
  markdown?: string;
  linkUrl?: string;
  children?: TemplatePage[];
}

export const TEMPLATES: Record<string, TemplatePage[]> = {
  blank: [
    {
      title: 'Introduction',
      description: 'Start writing your documentation here.',
      markdown: `Welcome to your new space! Type \`/\` anywhere to insert blocks like code, tables, callouts, diagrams and API references.

> [!TIP]
> Markdown works as you type: \`#\` for headings, \`-\` for lists, \`\`\`\` \`\`\` \`\`\`\` for code blocks and \`>\` for quotes.
`,
    },
  ],
  product: [
    {
      title: 'Welcome',
      description: 'An overview of the product and how this documentation is organized.',
      markdown: `This documentation helps you install, configure and get the most out of the product.

## Where to start

- **New here?** Follow the **Quickstart** to get running in five minutes.
- **Setting up for a team?** Read the configuration guides.
- **Building an integration?** Check the API reference.

> [!NOTE]
> Every page has a **Was this helpful?** widget at the bottom. Your feedback helps us improve these docs.
`,
    },
    {
      title: 'Getting started',
      kind: 'group',
      children: [
        {
          title: 'Quickstart',
          description: 'Get up and running in five minutes.',
          markdown: `## 1. Install

\`\`\`bash
npm install my-product
\`\`\`

## 2. Configure

Create a configuration file in your project root:

\`\`\`json
{
  "apiKey": "YOUR_API_KEY",
  "region": "eu-west-1"
}
\`\`\`

## 3. Run

\`\`\`bash
npx my-product start
\`\`\`

> [!TIP]
> Use \`--verbose\` to see detailed logs while you are getting started.
`,
        },
        {
          title: 'Installation',
          description: 'System requirements and installation options.',
          markdown: `## Requirements

| Component | Minimum | Recommended |
| --- | --- | --- |
| CPU | 2 cores | 4 cores |
| Memory | 2 GB | 8 GB |
| Disk | 10 GB | 50 GB SSD |

## Install options

- [ ] Package manager
- [ ] Docker image
- [ ] Build from source

\`\`\`mermaid
flowchart LR
  A[Download] --> B[Install]
  B --> C{Configure}
  C -->|Default| D[Run]
  C -->|Custom| E[Edit config] --> D
\`\`\`
`,
        },
      ],
    },
    {
      title: 'Guides',
      kind: 'group',
      children: [
        {
          title: 'Configuration',
          description: 'All configuration options explained.',
          markdown: `Configuration is read from environment variables and the config file. Environment variables take precedence.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| \`port\` | number | \`3000\` | Port to listen on |
| \`logLevel\` | string | \`info\` | One of \`debug\`, \`info\`, \`warn\`, \`error\` |

> [!WARNING]
> Never commit secrets to version control. Use environment variables for API keys.
`,
        },
        {
          title: 'Troubleshooting',
          description: 'Solutions to common problems.',
          markdown: `<details>
<summary>The service does not start</summary>

Check that the configured port is free and that you have permission to bind to it.

</details>

<details>
<summary>I get an authentication error</summary>

Make sure your API key is valid and has not expired.

</details>
`,
        },
      ],
    },
  ],
  api: [
    {
      title: 'Overview',
      description: 'Introduction to the API.',
      markdown: `The API is organized around REST. It accepts JSON request bodies, returns JSON responses and uses standard HTTP status codes.

## Authentication

Authenticate with a bearer token in the \`Authorization\` header:

\`\`\`bash
curl https://api.example.com/v1/me -H "Authorization: Bearer $TOKEN"
\`\`\`

> [!TIP]
> Import an OpenAPI specification from **Space settings → OpenAPI** to generate a complete, interactive API reference.
`,
    },
    {
      title: 'Errors',
      description: 'HTTP status codes and error format.',
      markdown: `| Code | Meaning |
| --- | --- |
| \`400\` | Bad request — the request was invalid |
| \`401\` | Unauthorized — missing or invalid token |
| \`404\` | Not found |
| \`429\` | Too many requests |
| \`500\` | Server error |

\`\`\`json
{ "error": { "code": "invalid_request", "message": "The 'name' field is required." } }
\`\`\`
`,
    },
  ],
};
