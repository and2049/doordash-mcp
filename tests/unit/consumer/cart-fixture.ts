export const cart = {
  id: 'cart-one', subtotal: 1000, total: null, currencyCode: 'USD', groupCart: false, submittedAt: null,
  isConsumerPickup: false, hasError: null, restaurant: { id: '2', name: 'Test Store' }, menu: { id: '3' },
  orders: [{ orderItems: [{ id: 'cart-line', quantity: 1, singlePrice: null, nestedOptions: '[]', specialInstructions: '', item: { id: '4', name: 'Test Item' } }] }],
};
export const checkout = {
  ...cart, total: 1500, tipAmount: 100, merchantTipAmount: null, taxAmount: null, deliveryFee: null, appliedServiceFee: null,
  minOrderFee: null, extraSosDeliveryFee: null, fulfillsOwnDeliveries: false, containsAlcohol: false, isMerchantShipping: false,
  isPrescriptionDelivery: null, isBundle: false, isCatering: false, selectedDeliveryOption: null,
  orders: cart.orders.map((order) => ({ ...order, paymentCard: { id: '123' } })), lineItemsList: [{ label: 'Subtotal', finalMoney: { unitAmount: 1000, displayString: '$10.00' } }],
};
