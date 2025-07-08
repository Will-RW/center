# HOW TO UPDATE YOUR WIZED EXPORT FOR A SHARED CODEBASE

1. **Export Your Wized Config**

   - In Wized, use the “Export” or “Push Code” feature to download your project’s export file.
   - You’ll typically get a file with minified JavaScript or JSON.

2. **Find the “endpoint” Line for Centroid**

   - Open the exported file in a text editor (like the Glitch editor, VS Code, or any code editor).
   - Search for a line containing `ping?id=` or `endpoint:`.
     > **Example:**
     >
     > ```js
     > endpoint: "return 'ping?id=southsider&token=-dwwGiNSFOeJj94mkS0OXzPVrLsesont';"
     > ```

3. **Replace Hard-Coded Values With Placeholders**

   - Change that line to:
     ```js
     endpoint: return 'ping?id=%%ID%%&token=%%TOKEN%%'
     ```

4. **(Optional) Beautify If Needed**

   - If the export is heavily minified, you can copy-paste into an online “JS Beautifier” or “Prettier” to make it more readable.
   - Then locate the `ping?id=` line again and replace accordingly.

5. **Save the Edited File**

   - Name it something like: `wized-export.js`
   - Place it in your Glitch project.

6. **Serve It Via Your Node Server (Optional)**

   - If you’re using domain-based or environment-variable injection, your server code can replace `%%ID%%` and `%%TOKEN%%` at runtime.

7. **Keep the Wized Engine Script in Webflow**

   - In your Webflow project:
     1. **Keep** the line that loads Wized’s engine:
        ```html
        <script
          async
          type="module"
          data-wized-id="YOUR_PROJECT_ID"
          src="https://embed.wized.com/v2/index.js"
        ></script>
        ```
     2. **Remove** the default “Wized config” script:
        ```html
        <script async src="https://embed.wized.com/YOUR_PROJECT_ID.js"></script>
        ```
     3. **Add** your new reference pointing to the Glitch route or file:
        ```html
        <script
          async
          src="https://your-glitch-project.glitch.me/wized-export.js"
        ></script>
        ```

8. **Test It**
   - Publish your Webflow site.
   - Check the Developer Console (F12) for errors.
   - Confirm your site loads the code from the new custom URL and that Wized functions normally.
