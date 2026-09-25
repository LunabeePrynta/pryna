import '@shopify/ui-extensions/preact';
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const ids = shopify.data.selected.map((item) => item.id);
  // Relative URLs resolve against the app URL; Shopify sends the session token with the request.
  const src = `/print?${new URLSearchParams({ orderIds: ids.join(',') })}`;

  return (
    <s-admin-print-action src={src}>
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">{ids.length === 1 ? 'India Post shipping label' : `India Post labels for ${ids.length} orders`}</s-text>
        <s-text>
          Orders not yet booked are skipped. Book them first from More actions → Create India Post shipment.
        </s-text>
      </s-stack>
    </s-admin-print-action>
  );
}
