export const DEMO_SPEC = `openapi: 3.0.3
info:
  title: Acme Store API
  version: 1.2.0
  description: |
    The Acme Store API lets you manage products and orders.
    All requests must be authenticated with a bearer token.
servers:
  - url: https://api.acme.test/v1
    description: Production
tags:
  - name: Products
    description: Create, list and manage products in your catalog.
  - name: Orders
    description: Place and track customer orders.
security:
  - bearerAuth: []
paths:
  /products:
    get:
      tags: [Products]
      summary: List products
      description: Returns a paginated list of products, newest first.
      operationId: listProducts
      parameters:
        - name: limit
          in: query
          description: Maximum number of products to return (1-100).
          schema: { type: integer, default: 20 }
        - name: cursor
          in: query
          description: Cursor from a previous response for pagination.
          schema: { type: string }
      responses:
        '200':
          description: A page of products
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/Product' }
                  next_cursor: { type: string, nullable: true }
        '401': { $ref: '#/components/responses/Unauthorized' }
    post:
      tags: [Products]
      summary: Create a product
      operationId: createProduct
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ProductInput' }
      responses:
        '201':
          description: The created product
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Product' }
        '400': { description: Invalid input }
  /products/{productId}:
    get:
      tags: [Products]
      summary: Retrieve a product
      operationId: getProduct
      parameters:
        - name: productId
          in: path
          required: true
          schema: { type: string, example: prod_123 }
      responses:
        '200':
          description: The product
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Product' }
        '404': { description: Product not found }
    delete:
      tags: [Products]
      summary: Delete a product
      operationId: deleteProduct
      parameters:
        - name: productId
          in: path
          required: true
          schema: { type: string }
      responses:
        '204': { description: Deleted }
  /orders:
    post:
      tags: [Orders]
      summary: Place an order
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [items]
              properties:
                customer_email: { type: string, format: email }
                items:
                  type: array
                  items:
                    type: object
                    required: [product_id, quantity]
                    properties:
                      product_id: { type: string }
                      quantity: { type: integer, minimum: 1 }
      responses:
        '201':
          description: Order created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
  /orders/{orderId}:
    get:
      tags: [Orders]
      summary: Retrieve an order
      operationId: getOrder
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: API key from your dashboard
  responses:
    Unauthorized:
      description: Missing or invalid token
  schemas:
    ProductInput:
      type: object
      required: [name, price]
      properties:
        name: { type: string, example: Coffee mug }
        description: { type: string }
        price: { type: integer, description: Price in cents, example: 1299 }
        currency: { type: string, enum: [usd, eur, gbp], default: usd }
    Product:
      allOf:
        - $ref: '#/components/schemas/ProductInput'
        - type: object
          properties:
            id: { type: string, example: prod_123 }
            created_at: { type: string, format: date-time }
    Order:
      type: object
      properties:
        id: { type: string, example: ord_456 }
        status: { type: string, enum: [pending, paid, shipped, cancelled] }
        total: { type: integer, description: Total in cents }
        items:
          type: array
          items:
            type: object
            properties:
              product: { $ref: '#/components/schemas/Product' }
              quantity: { type: integer }
`;
