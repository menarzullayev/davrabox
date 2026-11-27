<#import "template.ftl" as layout>
<@layout.emailLayout>
<@layout.title text=msg("dbLinkTitle", identityProviderDisplayName)/>
<@layout.para text=msg("dbLinkLead", identityProviderDisplayName, identityProviderContext.username)/>
<@layout.button href=link label=msg("dbLinkButton", identityProviderDisplayName)/>
<@layout.muted text=msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))/>
<@layout.muted text=msg("dbLinkIgnore")/>
</@layout.emailLayout>
