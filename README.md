# The Business Lab Website

Professional consulting website for Fortune 500 wellness consulting services.

## Features

- **Responsive Design**: Mobile-first approach with professional aesthetics
- **Professional Styling**: Inspired by top-tier consulting firms like Stern Value Management
- **Modern Architecture**: Clean HTML5, CSS3, and vanilla JavaScript
- **Performance Optimized**: Fast loading with optimized assets
- **SEO Ready**: Semantic markup and meta tags
- **Form Integration**: Contact form ready for backend integration

## Structure

```
business-lab-website/
├── index.html          # Main homepage
├── styles.css          # All styling
├── script.js           # Interactive functionality
├── netlify.toml        # Deployment configuration
└── README.md           # This file
```

## Deployment to Netlify

### Option 1: Manual Upload
1. Zip the entire `business-lab-website` folder
2. Go to Netlify dashboard
3. Drag and drop the zip file
4. Configure custom domain: `business-lab.com`

### Option 2: Git Repository
1. Initialize git repository:
   ```bash
   cd business-lab-website
   git init
   git add .
   git commit -m "Initial The Business Lab website"
   ```
2. Create GitHub repository
3. Push to GitHub
4. Connect Netlify to GitHub repository
5. Configure build settings (already in netlify.toml)

### Domain Configuration
1. In Netlify dashboard, go to Domain settings
2. Add custom domain: `business-lab.com`
3. Configure DNS records:
   - A record: @ → Netlify IP
   - CNAME: www → your-site.netlify.app

## Customization

### Colors
Primary brand colors can be changed in `styles.css`:
- Primary Blue: `#2563eb`
- Dark Blue: `#1d4ed8`
- Text Dark: `#1a1a1a`
- Text Gray: `#4a5568`

### Content
All content can be edited directly in `index.html`:
- Hero section statistics
- Service offerings and pricing
- Company information
- Contact details

### Forms
The contact form is ready for integration with:
- Netlify Forms (add `netlify` attribute to form)
- FormAssembly
- Custom backend endpoints

## Performance Features

- Optimized Google Fonts loading
- Lazy loading animations
- Efficient CSS Grid layouts
- Minimal JavaScript footprint
- Compressed images and assets

## Browser Support

- Chrome 60+
- Firefox 60+
- Safari 12+
- Edge 79+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Next Steps

1. **Content Review**: Update all placeholder content with actual company information
2. **Form Integration**: Connect contact form to CRM/email system
3. **Analytics**: Add Google Analytics or similar tracking
4. **Partner Portal**: Build authenticated partner portal pages
5. **Blog/Resources**: Add content management for thought leadership
6. **SEO Optimization**: Add sitemap, structured data, and optimize meta tags

## Integration Points

Ready for integration with:
- Salesforce CRM
- Stripe payments
- FormAssembly forms
- ActiveCampaign email marketing
- Google Analytics/Tag Manager

## Support

For development questions or customizations, contact the development team.